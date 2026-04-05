const fastify = require('fastify')({ logger: true })
const { PrismaClient } = require('@prisma/client')
const jwt = require('jsonwebtoken')
const axios = require('axios')

const prisma = new PrismaClient()

// ─── CORS ─────────────────────────────────────────────────────────────────────
fastify.register(require('@fastify/cors'), {
  origin: [
    'https://glpkart.com',
    'https://www.glpkart.com',
    'https://glpkart-frontend.vercel.app',
    'http://localhost:3000',
  ],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
})

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'glpkart-jwt-secret-2026-changeme'
const OTP_BYPASS = process.env.OTP_BYPASS || null

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString()
}

function signToken(userId, role) {
  return jwt.sign({ userId, role }, JWT_SECRET, { expiresIn: '30d' })
}

function generatePersona() {
  const adj = ['Quiet', 'Gentle', 'Brave', 'Swift', 'Calm', 'Bold', 'Wise', 'Kind', 'Warm', 'Bright']
  const noun = ['River', 'Dawn', 'Path', 'Star', 'Ember', 'Maple', 'Stone', 'Wind', 'Lake', 'Peak']
  const num = Math.floor(10 + Math.random() * 90)
  return `${adj[Math.floor(Math.random() * adj.length)]}${noun[Math.floor(Math.random() * noun.length)]}_${num}`
}

async function sendWhatsAppOtp(phone, otp) {
  const apiKey = process.env.GUPSHUP_API_KEY
  const appName = process.env.GUPSHUP_APP_NAME || 'GLPKart'
  const sender = process.env.GUPSHUP_SENDER_PHONE
  if (!apiKey || !sender) {
    fastify.log.warn('Gupshup not configured')
    return false
  }
  try {
    const message = `Your GLPKart verification code is *${otp}*. Valid for 10 minutes.`
    await axios.post('https://api.gupshup.io/sm/api/v1/msg',
      new URLSearchParams({
        channel: 'whatsapp',
        source: sender,
        destination: `91${phone}`,
        message: JSON.stringify({ type: 'text', text: message }),
        'src.name': appName,
      }),
      { headers: { apikey: apiKey, 'Content-Type': 'application/x-www-form-urlencoded' } }
    )
    return true
  } catch (err) {
    fastify.log.error('Gupshup error: ' + err.message)
    return false
  }
}

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────
async function requireAuth(request, reply) {
  const auth = request.headers.authorization
  if (!auth || !auth.startsWith('Bearer ')) {
    return reply.code(401).send({ error: 'Authentication required' })
  }
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET)
    request.userId = payload.userId
    request.userRole = payload.role
  } catch {
    return reply.code(401).send({ error: 'Invalid or expired token' })
  }
}

// ─── HEALTH ──────────────────────────────────────────────────────────────────
fastify.get('/', async () => ({ name: 'GLPKart API', status: 'running', version: '2.0' }))
fastify.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }))

// ─── SEND OTP ────────────────────────────────────────────────────────────────
fastify.post('/auth/otp/send', async (request, reply) => {
  const { phone } = request.body || {}
  if (!phone || !/^[6-9]\d{9}$/.test(phone)) {
    return reply.code(400).send({ error: 'Enter a valid 10-digit Indian mobile number' })
  }

  const otp = OTP_BYPASS || generateOtp()
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000)

  await prisma.oTPSession.upsert({
    where: { phone },
    create: { phone, code: otp, expiresAt, attempts: 0 },
    update: { code: otp, expiresAt, attempts: 0 },
  })

  const sent = await sendWhatsAppOtp(phone, otp)

  const response = { success: true, message: 'OTP sent to WhatsApp' }
  if (OTP_BYPASS) {
    response.debug_otp = otp
    response.message = 'Dev mode — OTP bypass active'
  } else if (!sent) {
    response.message = 'OTP generated. WhatsApp delivery may be delayed.'
  }

  return response
})

// ─── VERIFY OTP ──────────────────────────────────────────────────────────────
fastify.post('/auth/otp/verify', async (request, reply) => {
  const { phone, code } = request.body || {}
  if (!phone || !code) {
    return reply.code(400).send({ error: 'Phone and OTP are required' })
  }

  const session = await prisma.oTPSession.findUnique({ where: { phone } })
  if (!session) {
    return reply.code(400).send({ error: 'No OTP found. Please request a new one.' })
  }
  if (session.expiresAt < new Date()) {
    await prisma.oTPSession.delete({ where: { phone } })
    return reply.code(400).send({ error: 'OTP expired. Please request a new one.' })
  }
  if (session.attempts >= 5) {
    return reply.code(429).send({ error: 'Too many attempts. Please request a new OTP.' })
  }
  if (session.code !== code.toString()) {
    await prisma.oTPSession.update({ where: { phone }, data: { attempts: { increment: 1 } } })
    return reply.code(400).send({ error: 'Incorrect OTP. Please try again.' })
  }

  await prisma.oTPSession.delete({ where: { phone } })

  let user = await prisma.user.findUnique({ where: { phone } })
  if (!user) {
    user = await prisma.user.create({
      data: {
        phone,
        role: 'PATIENT',
        forumPersona: generatePersona(),
        patientProfile: { create: {} },
      },
    })
  }

  const completedConsult = await prisma.consultation.findFirst({
    where: { patientId: user.id, status: 'COMPLETED' },
  })

  const token = signToken(user.id, user.role)

  return {
    success: true,
    accessToken: token,
    user: {
      id: user.id,
      phone: user.phone,
      role: user.role,
      forumPersona: user.forumPersona,
      hasCompletedConsultation: !!completedConsult,
    },
  }
})

// ─── LOGOUT ───────────────────────────────────────────────────────────────────
fastify.post('/auth/logout', async () => ({ success: true }))

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
fastify.get('/journey/dashboard', { preHandler: requireAuth }, async (request, reply) => {
  const profile = await prisma.patientProfile.findUnique({ where: { userId: request.userId } })
  if (!profile) return reply.code(404).send({ error: 'Profile not found' })

  const weightLogs = await prisma.weightLog.findMany({
    where: { patientId: request.userId },
    orderBy: { loggedAt: 'asc' },
    take: 30,
    select: { weightKg: true, loggedAt: true },
  })

  const nextInjection = await prisma.injectionLog.findFirst({
    where: { patientId: request.userId, dueAt: { gte: new Date() } },
    orderBy: { dueAt: 'asc' },
  })

  const nextConsult = await prisma.consultation.findFirst({
    where: { patientId: request.userId, status: 'SCHEDULED', scheduledAt: { gte: new Date() } },
    orderBy: { scheduledAt: 'asc' },
    include: { doctor: { select: { fullName: true } } },
  })

  return {
    profile: {
      fullName: profile.fullName,
      currentWeightKg: profile.currentWeightKg ? Number(profile.currentWeightKg) : null,
      startWeightKg: profile.startWeightKg ? Number(profile.startWeightKg) : null,
      goalWeightKg: profile.goalWeightKg ? Number(profile.goalWeightKg) : null,
      totalLostKg: profile.startWeightKg && profile.currentWeightKg
        ? Math.max(0, Number(profile.startWeightKg) - Number(profile.currentWeightKg))
        : 0,
      weekNumber: profile.treatmentStartDate
        ? Math.floor((Date.now() - new Date(profile.treatmentStartDate).getTime()) / (7 * 24 * 60 * 60 * 1000)) + 1
        : 0,
      assignedDoctor: nextConsult?.doctor?.fullName || null,
    },
    weightLogs: weightLogs.map(l => ({ date: l.loggedAt, weightKg: Number(l.weightKg) })),
    nextInjection: nextInjection ? {
      medicineName: nextInjection.medicineName,
      doseMg: nextInjection.doseMg,
      dueAt: nextInjection.dueAt,
    } : null,
    nextConsult: nextConsult ? {
      scheduledAt: nextConsult.scheduledAt,
      doctorName: nextConsult.doctor?.fullName || 'Doctor',
    } : null,
  }
})

// ─── LOG WEIGHT ──────────────────────────────────────────────────────────────
fastify.post('/journey/weight', { preHandler: requireAuth }, async (request, reply) => {
  const { weightKg } = request.body || {}
  if (!weightKg || isNaN(Number(weightKg))) return reply.code(400).send({ error: 'Invalid weight' })
  await Promise.all([
    prisma.weightLog.create({ data: { patientId: request.userId, weightKg: Number(weightKg) } }),
    prisma.patientProfile.update({ where: { userId: request.userId }, data: { currentWeightKg: Number(weightKg) } }),
  ])
  return { success: true }
})

// ─── FORUM ────────────────────────────────────────────────────────────────────
fastify.get('/forum/posts', { preHandler: requireAuth }, async (request) => {
  const { topic, cursor, limit = 20 } = request.query || {}
  const posts = await prisma.forumPost.findMany({
    where: { isDeleted: false, ...(topic ? { topic } : {}), ...(cursor ? { id: { lt: cursor } } : {}) },
    orderBy: { createdAt: 'desc' },
    take: Number(limit),
    include: { _count: { select: { replies: true } }, author: { select: { forumPersona: true, role: true } } },
  })
  return {
    posts: posts.map(p => ({
      id: p.id,
      personaName: p.author.forumPersona || 'Anonymous',
      title: p.title,
      body: p.body,
      topic: p.topic,
      isDoctorPost: p.author.role === 'DOCTOR',
      helpfulCount: p.helpfulCount,
      createdAt: p.createdAt,
      _count: p._count,
    })),
  }
})

fastify.post('/forum/posts', { preHandler: requireAuth }, async (request, reply) => {
  const { title, body, topic } = request.body || {}
  if (!title?.trim() || !body?.trim()) return reply.code(400).send({ error: 'Title and body are required' })
  const post = await prisma.forumPost.create({
    data: { authorId: request.userId, title: title.trim(), body: body.trim(), topic: topic || 'OTHER' },
    include: { author: { select: { forumPersona: true } } },
  })
  return { success: true, post: { ...post, personaName: post.author.forumPersona } }
})

fastify.post('/forum/posts/:id/helpful', { preHandler: requireAuth }, async (request) => {
  const post = await prisma.forumPost.update({
    where: { id: request.params.id },
    data: { helpfulCount: { increment: 1 } },
  })
  return { success: true, helpfulCount: post.helpfulCount }
})

// ─── CONSULTATIONS ────────────────────────────────────────────────────────────
fastify.post('/consultations', { preHandler: requireAuth }, async (request, reply) => {
  const { doctorId, scheduledAt } = request.body || {}
  if (!doctorId || !scheduledAt) return reply.code(400).send({ error: 'doctorId and scheduledAt are required' })
  const doctor = await prisma.doctor.findUnique({ where: { id: doctorId } })
  if (!doctor) return reply.code(404).send({ error: 'Doctor not found' })
  const consult = await prisma.consultation.create({
    data: { patientId: request.userId, doctorId, scheduledAt: new Date(scheduledAt), status: 'SCHEDULED', feePaise: 79900 },
  })
  return { success: true, consultation: consult }
})

fastify.get('/consultations', { preHandler: requireAuth }, async (request) => {
  const consultations = await prisma.consultation.findMany({
    where: { patientId: request.userId },
    orderBy: { scheduledAt: 'desc' },
    include: { doctor: { select: { fullName: true } } },
  })
  return { consultations }
})

// ─── PRESCRIPTIONS ────────────────────────────────────────────────────────────
fastify.get('/prescriptions', { preHandler: requireAuth }, async (request) => {
  const prescriptions = await prisma.prescription.findMany({
    where: { patientId: request.userId },
    orderBy: { issuedAt: 'desc' },
  })
  return { prescriptions }
})

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '8080')
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) { console.error(err); process.exit(1) }
  console.log('GLPKart API v2 running on port ' + PORT)
})
