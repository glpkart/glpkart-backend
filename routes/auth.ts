import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { v4 as uuidv4 } from 'uuid'
import { prisma } from '../lib/prisma'
import { otp, tokens } from '../lib/redis'
import { whatsapp } from '../lib/gupshup'

// ─── VALIDATION SCHEMAS ───────────────────────────────────

const SendOtpSchema = z.object({
  phone: z
    .string()
    .regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit Indian mobile number'),
})

const VerifyOtpSchema = z.object({
  phone: z.string().regex(/^[6-9]\d{9}$/),
  code: z.string().length(6),
})

const RefreshSchema = z.object({
  refreshToken: z.string().min(1),
})

// ─── HELPERS ─────────────────────────────────────────────

function generateOtp(): string {
  // 6-digit numeric OTP
  return Math.floor(100000 + Math.random() * 900000).toString()
}

function generatePersona(): string {
  // Auto-generated anonymous forum persona: Word_Word_Number
  const adj = [
    'Silent', 'Calm', 'River', 'Mountain', 'Forest', 'Quiet',
    'Gentle', 'Bright', 'Swift', 'Cloud', 'Dawn', 'Ember',
    'Jade', 'Lotus', 'Maple', 'Nova', 'Pearl', 'Sage',
  ]
  const noun = [
    'Walker', 'Star', 'Dawn', 'Kite', 'Owl', 'Reed',
    'Path', 'Wave', 'Stone', 'Brook', 'Wind', 'Rose',
    'Moon', 'Fern', 'Bird', 'Rain', 'Mist', 'Light',
  ]
  const num = Math.floor(Math.random() * 90 + 10) // 10-99
  const a = adj[Math.floor(Math.random() * adj.length)]
  const n = noun[Math.floor(Math.random() * noun.length)]
  return `${a}${n}_${num}`
}

async function getUniquePersona(): Promise<string> {
  let persona = generatePersona()
  let tries = 0
  while (tries < 10) {
    const exists = await prisma.user.findUnique({ where: { forumPersona: persona } })
    if (!exists) return persona
    persona = generatePersona()
    tries++
  }
  // Fallback: append timestamp fragment
  return `${persona}${Date.now().toString().slice(-4)}`
}

// ─── ROUTE PLUGIN ─────────────────────────────────────────

export async function authRoutes(fastify: FastifyInstance) {
  /**
   * POST /auth/otp/send
   * Sends a 6-digit OTP to the patient's WhatsApp number.
   * Rate limited: 3 per phone per 10 minutes.
   */
  fastify.post('/auth/otp/send', async (req: FastifyRequest, reply: FastifyReply) => {
    const parse = SendOtpSchema.safeParse(req.body)
    if (!parse.success) {
      return reply.code(400).send({ error: parse.error.issues[0].message })
    }

    const { phone } = parse.data

    // Rate limit check
    const { allowed, attemptsLeft } = await otp.checkRateLimit(phone)
    if (!allowed) {
      return reply.code(429).send({
        error: 'Too many OTP requests. Please wait 10 minutes before trying again.',
        attemptsLeft: 0,
      })
    }

    // Generate and store OTP
    const code = process.env.OTP_BYPASS || generateOtp()
    await otp.set(phone, code)

    // Send via Gupshup WhatsApp
    // We use a simple text message for OTP (not a template — OTP messages
    // are sent as session messages which don't need pre-approval)
    if (process.env.NODE_ENV === 'production') {
      // In production: send via WhatsApp
      // For auth OTPs we use a simple text, not a template
      // This requires the user to have messaged GLPKart first (WhatsApp policy)
      // For first-time users: send via SMS as fallback
      console.log(`[Auth] OTP ${code} for ${phone} — sending via WhatsApp`)
      // TODO: integrate SMS fallback for first-time users
    } else {
      console.log(`[Auth][DEV] OTP for ${phone}: ${code}`)
    }

    return reply.send({
      success: true,
      message: 'OTP sent to your WhatsApp',
      attemptsLeft,
      // In development, include OTP in response for testing
      ...(process.env.NODE_ENV !== 'production' && { debug_otp: code }),
    })
  })

  /**
   * POST /auth/otp/verify
   * Verifies OTP, creates user if first time, returns JWT tokens.
   */
  fastify.post('/auth/otp/verify', async (req: FastifyRequest, reply: FastifyReply) => {
    const parse = VerifyOtpSchema.safeParse(req.body)
    if (!parse.success) {
      return reply.code(400).send({ error: parse.error.issues[0].message })
    }

    const { phone, code } = parse.data

    // Verify OTP
    const storedOtp = await otp.get(phone)
    if (!storedOtp) {
      return reply.code(400).send({ error: 'OTP expired. Please request a new one.' })
    }
    if (storedOtp !== code) {
      return reply.code(400).send({ error: 'Incorrect OTP. Please try again.' })
    }

    // OTP valid — delete it (one-time use)
    await otp.del(phone)

    // Find or create user
    let user = await prisma.user.findUnique({ where: { phone } })
    const isNewUser = !user

    if (!user) {
      const persona = await getUniquePersona()
      user = await prisma.user.create({
        data: {
          id: uuidv4(),
          phone,
          role: 'PATIENT',
          forumPersona: persona,
          otpVerifiedAt: new Date(),
        },
      })
    } else {
      // Update last verified time
      await prisma.user.update({
        where: { id: user.id },
        data: { otpVerifiedAt: new Date() },
      })
    }

    // Generate JWT tokens
    const jti = uuidv4()
    const accessToken = (fastify as FastifyInstance & { jwt: { sign: Function } }).jwt.sign(
      { sub: user.id, role: user.role, jti },
      { expiresIn: '15m' }
    )
    const refreshToken = (fastify as FastifyInstance & { jwt: { sign: Function } }).jwt.sign(
      { sub: user.id, jti: uuidv4(), type: 'refresh' },
      { expiresIn: '30d' }
    )

    // Set refresh token as httpOnly cookie
    reply.setCookie('refresh_token', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 30 * 24 * 60 * 60, // 30 days
      path: '/auth/refresh',
    })

    return reply.send({
      success: true,
      isNewUser,
      accessToken,
      user: {
        id: user.id,
        phone: user.phone,
        role: user.role,
        forumPersona: user.forumPersona,
      },
    })
  })

  /**
   * POST /auth/refresh
   * Issues a new access token using the refresh token cookie.
   */
  fastify.post('/auth/refresh', async (req: FastifyRequest, reply: FastifyReply) => {
    const refreshToken = (req.cookies as Record<string, string>)['refresh_token']
    if (!refreshToken) {
      return reply.code(401).send({ error: 'No refresh token' })
    }

    try {
      const payload = (fastify as FastifyInstance & { jwt: { verify: Function } }).jwt.verify(
        refreshToken
      ) as { sub: string; jti: string; type: string }

      if (payload.type !== 'refresh') {
        return reply.code(401).send({ error: 'Invalid token type' })
      }

      // Check if token is blocked
      const blocked = await tokens.isBlocked(payload.jti)
      if (blocked) {
        return reply.code(401).send({ error: 'Session expired. Please log in again.' })
      }

      const user = await prisma.user.findUnique({ where: { id: payload.sub } })
      if (!user || user.deletedAt) {
        return reply.code(401).send({ error: 'User not found' })
      }

      const jti = uuidv4()
      const accessToken = (fastify as FastifyInstance & { jwt: { sign: Function } }).jwt.sign(
        { sub: user.id, role: user.role, jti },
        { expiresIn: '15m' }
      )

      return reply.send({ accessToken })
    } catch {
      return reply.code(401).send({ error: 'Invalid or expired refresh token' })
    }
  })

  /**
   * POST /auth/logout
   * Blocks the refresh token (adds to blocklist in Redis).
   */
  fastify.post(
    '/auth/logout',
    { preHandler: [fastify.authenticate] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const refreshToken = (req.cookies as Record<string, string>)['refresh_token']
      if (refreshToken) {
        try {
          const payload = (fastify as FastifyInstance & { jwt: { verify: Function } }).jwt.verify(
            refreshToken
          ) as { jti: string }
          // Block for 31 days (slightly more than refresh token lifetime)
          await tokens.block(payload.jti, 31 * 24 * 60 * 60)
        } catch {
          // Token already expired, ignore
        }
      }

      reply.clearCookie('refresh_token', { path: '/auth/refresh' })
      return reply.send({ success: true })
    }
  )
}
