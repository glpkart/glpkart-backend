import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { v4 as uuidv4 } from 'uuid'
import { prisma } from '../lib/prisma'
import { otp, tokens } from '../lib/redis'

const SendOtpSchema = z.object({
  phone: z.string().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit Indian mobile number'),
})

const VerifyOtpSchema = z.object({
  phone: z.string().regex(/^[6-9]\d{9}$/),
  code: z.string().length(6),
})

function generateOtp(): string {
  return Math.floor(100000 + Math.random() * 900000).toString()
}

function generatePersona(): string {
  const adj = ['Silent','Calm','River','Mountain','Forest','Quiet','Gentle','Bright','Swift','Cloud','Dawn','Ember','Jade','Lotus','Maple','Nova','Pearl','Sage']
  const noun = ['Walker','Star','Dawn','Kite','Owl','Reed','Path','Wave','Stone','Brook','Wind','Rose','Moon','Fern','Bird','Rain','Mist','Light']
  const num = Math.floor(Math.random() * 90 + 10)
  return `${adj[Math.floor(Math.random()*adj.length)]}${noun[Math.floor(Math.random()*noun.length)]}_${num}`
}

async function getUniquePersona(): Promise<string> {
  let persona = generatePersona()
  for (let i = 0; i < 10; i++) {
    const exists = await prisma.user.findUnique({ where: { forumPersona: persona } })
    if (!exists) return persona
    persona = generatePersona()
  }
  return `${persona}${Date.now().toString().slice(-4)}`
}

export async function authRoutes(fastify: FastifyInstance) {
  /**
   * POST /auth/otp/send
   */
  fastify.post('/auth/otp/send', async (req: FastifyRequest, reply: FastifyReply) => {
    const parse = SendOtpSchema.safeParse(req.body)
    if (!parse.success) return reply.code(400).send({ error: parse.error.issues[0].message })

    const { phone } = parse.data
    const { allowed, attemptsLeft } = await otp.checkRateLimit(phone)
    if (!allowed) return reply.code(429).send({ error: 'Too many OTP requests. Wait 10 minutes.' })

    const code = process.env.OTP_BYPASS || generateOtp()
    await otp.set(phone, code)

    if (process.env.NODE_ENV !== 'production') {
      console.log(`[Auth][DEV] OTP for ${phone}: ${code}`)
    }

    return reply.send({
      success: true,
      message: 'OTP sent to your WhatsApp',
      attemptsLeft,
      ...(process.env.NODE_ENV !== 'production' && { debug_otp: code }),
    })
  })

  /**
   * POST /auth/otp/verify
   */
  fastify.post('/auth/otp/verify', async (req: FastifyRequest, reply: FastifyReply) => {
    const parse = VerifyOtpSchema.safeParse(req.body)
    if (!parse.success) return reply.code(400).send({ error: parse.error.issues[0].message })

    const { phone, code } = parse.data
    const storedOtp = await otp.get(phone)
    if (!storedOtp) return reply.code(400).send({ error: 'OTP expired. Request a new one.' })
    if (storedOtp !== code) return reply.code(400).send({ error: 'Incorrect OTP.' })

    await otp.del(phone)

    let user = await prisma.user.findUnique({ where: { phone } })
    const isNewUser = !user

    if (!user) {
      const persona = await getUniquePersona()
      user = await prisma.user.create({
        data: { id: uuidv4(), phone, role: 'PATIENT', forumPersona: persona, otpVerifiedAt: new Date() },
      })
    } else {
      await prisma.user.update({ where: { id: user.id }, data: { otpVerifiedAt: new Date() } })
    }

    const jti = uuidv4()
    const accessToken = fastify.jwt.sign(
      { sub: user.id, role: user.role, jti },
      { expiresIn: '15m' }
    )
    const refreshToken = fastify.jwt.sign(
      { sub: user.id, jti: uuidv4(), type: 'refresh' },
      { expiresIn: '30d' }
    )

    reply.setCookie('refresh_token', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 30 * 24 * 60 * 60,
      path: '/auth/refresh',
    })

    return reply.send({
      success: true,
      isNewUser,
      accessToken,
      user: { id: user.id, phone: user.phone, role: user.role, forumPersona: user.forumPersona },
    })
  })

  /**
   * POST /auth/refresh
   */
  fastify.post('/auth/refresh', async (req: FastifyRequest, reply: FastifyReply) => {
    const refreshToken = (req.cookies as Record<string, string>)['refresh_token']
    if (!refreshToken) return reply.code(401).send({ error: 'No refresh token' })

    try {
      const payload = fastify.jwt.verify(refreshToken) as { sub: string; jti: string; type: string }
      if (payload.type !== 'refresh') return reply.code(401).send({ error: 'Invalid token type' })

      const blocked = await tokens.isBlocked(payload.jti)
      if (blocked) return reply.code(401).send({ error: 'Session expired. Please log in again.' })

      const user = await prisma.user.findUnique({ where: { id: payload.sub } })
      if (!user || user.deletedAt) return reply.code(401).send({ error: 'User not found' })

      const accessToken = fastify.jwt.sign(
        { sub: user.id, role: user.role, jti: uuidv4() },
        { expiresIn: '15m' }
      )
      return reply.send({ accessToken })
    } catch {
      return reply.code(401).send({ error: 'Invalid or expired refresh token' })
    }
  })

  /**
   * POST /auth/logout
   */
  fastify.post('/auth/logout', { preHandler: [fastify.authenticate] }, async (req: FastifyRequest, reply: FastifyReply) => {
    const refreshToken = (req.cookies as Record<string, string>)['refresh_token']
    if (refreshToken) {
      try {
        const payload = fastify.jwt.verify(refreshToken) as { jti: string }
        await tokens.block(payload.jti, 31 * 24 * 60 * 60)
      } catch { /* already expired */ }
    }
    reply.clearCookie('refresh_token', { path: '/auth/refresh' })
    return reply.send({ success: true })
  })
}
