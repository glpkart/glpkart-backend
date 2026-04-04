import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { v4 as uuidv4 } from 'uuid'
import { prisma } from '../lib/prisma'

// ─── VALIDATION ───────────────────────────────────────────

const LogWeightSchema = z.object({
  weightKg: z.number().min(20).max(300),
  waistCm: z.number().min(40).max(250).optional(),
  source: z.enum(['app', 'whatsapp']).default('app'),
})

const LogInjectionSchema = z.object({
  medicineName: z.string().min(1),
  doseMg: z.number().positive(),
  injectionSite: z.enum(['LEFT_ABDOMEN', 'RIGHT_ABDOMEN', 'LEFT_THIGH', 'RIGHT_THIGH']),
  injectedAt: z.string().datetime().optional(),
  dueAt: z.string().datetime(),
  skipped: z.boolean().default(false),
  skipReason: z.string().optional(),
})

const LogSideEffectSchema = z.object({
  symptom: z.string().min(1),
  severity: z.number().int().min(1).max(5),
  notes: z.string().optional(),
})

// ─── FLAG ENGINE ─────────────────────────────────────────
// Checks patient data and creates flags for the doctor

async function runFlagEngine(patientId: string) {
  const now = new Date()
  const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000)
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)

  // ── Flag: No weight log in 10 days ──
  const recentWeightLog = await prisma.weightLog.findFirst({
    where: { patientId, loggedAt: { gte: tenDaysAgo } },
    orderBy: { loggedAt: 'desc' },
  })

  if (!recentWeightLog) {
    const existingFlag = await prisma.patientFlag.findFirst({
      where: { patientId, flagType: 'no_weight_log', resolved: false },
    })
    if (!existingFlag) {
      await prisma.patientFlag.create({
        data: {
          id: uuidv4(),
          patientId,
          flagType: 'no_weight_log',
          severity: 'warning',
          data: { daysSinceLastLog: 10 },
        },
      })
    }
  }

  // ── Flag: Rapid weight loss (>3kg in 7 days) ──
  const weightsThisWeek = await prisma.weightLog.findMany({
    where: { patientId, loggedAt: { gte: sevenDaysAgo } },
    orderBy: { loggedAt: 'asc' },
  })

  if (weightsThisWeek.length >= 2) {
    const first = parseFloat(weightsThisWeek[0].weightKg.toString())
    const last = parseFloat(weightsThisWeek[weightsThisWeek.length - 1].weightKg.toString())
    const loss = first - last
    if (loss > 3) {
      const existingFlag = await prisma.patientFlag.findFirst({
        where: { patientId, flagType: 'rapid_weight_loss', resolved: false },
      })
      if (!existingFlag) {
        await prisma.patientFlag.create({
          data: {
            id: uuidv4(),
            patientId,
            flagType: 'rapid_weight_loss',
            severity: 'warning',
            data: { lossKg: loss, periodDays: 7 },
          },
        })
      }
    }
  }

  // ── Flag: Missed 2+ injections ──
  const missedInjections = await prisma.injectionLog.count({
    where: {
      patientId,
      skipped: true,
      dueAt: { gte: sevenDaysAgo },
    },
  })

  if (missedInjections >= 2) {
    const existingFlag = await prisma.patientFlag.findFirst({
      where: { patientId, flagType: 'missed_injections', resolved: false },
    })
    if (!existingFlag) {
      await prisma.patientFlag.create({
        data: {
          id: uuidv4(),
          patientId,
          flagType: 'missed_injections',
          severity: 'warning',
          data: { count: missedInjections, period: '7d' },
        },
      })
    }
  }
}

// ─── INJECTION SITE ROTATION ──────────────────────────────

const SITE_ROTATION = [
  'LEFT_ABDOMEN',
  'RIGHT_ABDOMEN',
  'LEFT_THIGH',
  'RIGHT_THIGH',
] as const

async function getNextInjectionSite(patientId: string): Promise<string> {
  const lastInjection = await prisma.injectionLog.findFirst({
    where: { patientId, skipped: false },
    orderBy: { dueAt: 'desc' },
  })

  if (!lastInjection) return 'LEFT_ABDOMEN'

  const currentIndex = SITE_ROTATION.indexOf(
    lastInjection.injectionSite as (typeof SITE_ROTATION)[number]
  )
  const nextIndex = (currentIndex + 1) % SITE_ROTATION.length
  return SITE_ROTATION[nextIndex]
}

// ─── ROUTES ───────────────────────────────────────────────

export async function journeyRoutes(fastify: FastifyInstance) {
  /**
   * POST /journey/weight
   * Log a weight entry. Triggers flag engine after logging.
   */
  fastify.post(
    '/journey/weight',
    { preHandler: [fastify.authenticate] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parse = LogWeightSchema.safeParse(req.body)
      if (!parse.success) {
        return reply.code(400).send({ error: parse.error.issues[0].message })
      }

      const { weightKg, waistCm, source } = parse.data
      const patientId = await getPatientId(req.glpUser.id)
      if (!patientId) return reply.code(404).send({ error: 'Patient profile not found' })

      const log = await prisma.weightLog.create({
        data: {
          id: uuidv4(),
          patientId,
          weightKg,
          waistCm: waistCm ?? null,
          source,
          loggedAt: new Date(),
        },
      })

      // Update current weight on profile
      await prisma.patientProfile.update({
        where: { id: patientId },
        data: { currentWeightKg: weightKg },
      })

      // Run flag engine asynchronously (don't block response)
      runFlagEngine(patientId).catch(console.error)

      return reply.send({ success: true, log })
    }
  )

  /**
   * GET /journey/weight
   * Get weight history for the logged-in patient.
   */
  fastify.get(
    '/journey/weight',
    { preHandler: [fastify.authenticate] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const query = req.query as { limit?: string; days?: string }
      const limit = parseInt(query.limit || '30')
      const days = parseInt(query.days || '90')
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

      const patientId = await getPatientId(req.glpUser.id)
      if (!patientId) return reply.code(404).send({ error: 'Patient profile not found' })

      const logs = await prisma.weightLog.findMany({
        where: { patientId, loggedAt: { gte: since } },
        orderBy: { loggedAt: 'asc' },
        take: limit,
      })

      const profile = await prisma.patientProfile.findUnique({
        where: { id: patientId },
        select: { startWeightKg: true, currentWeightKg: true, goalWeightKg: true },
      })

      const totalLostKg = profile
        ? parseFloat(profile.startWeightKg.toString()) -
          parseFloat((profile.currentWeightKg || profile.startWeightKg).toString())
        : 0

      return reply.send({ logs, stats: { ...profile, totalLostKg: Math.round(totalLostKg * 10) / 10 } })
    }
  )

  /**
   * POST /journey/injection
   * Log an injection (taken or skipped).
   */
  fastify.post(
    '/journey/injection',
    { preHandler: [fastify.authenticate] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parse = LogInjectionSchema.safeParse(req.body)
      if (!parse.success) {
        return reply.code(400).send({ error: parse.error.issues[0].message })
      }

      const patientId = await getPatientId(req.glpUser.id)
      if (!patientId) return reply.code(404).send({ error: 'Patient profile not found' })

      const log = await prisma.injectionLog.create({
        data: {
          id: uuidv4(),
          patientId,
          ...parse.data,
          injectedAt: parse.data.injectedAt ? new Date(parse.data.injectedAt) : new Date(),
          dueAt: new Date(parse.data.dueAt),
        },
      })

      runFlagEngine(patientId).catch(console.error)

      return reply.send({ success: true, log })
    }
  )

  /**
   * GET /journey/injection/next-site
   * Returns the recommended next injection site based on rotation.
   */
  fastify.get(
    '/journey/injection/next-site',
    { preHandler: [fastify.authenticate] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const patientId = await getPatientId(req.glpUser.id)
      if (!patientId) return reply.code(404).send({ error: 'Patient profile not found' })

      const nextSite = await getNextInjectionSite(patientId)
      return reply.send({ nextSite })
    }
  )

  /**
   * POST /journey/side-effect
   * Log a side effect with severity.
   */
  fastify.post(
    '/journey/side-effect',
    { preHandler: [fastify.authenticate] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parse = LogSideEffectSchema.safeParse(req.body)
      if (!parse.success) {
        return reply.code(400).send({ error: parse.error.issues[0].message })
      }

      const patientId = await getPatientId(req.glpUser.id)
      if (!patientId) return reply.code(404).send({ error: 'Patient profile not found' })

      const log = await prisma.sideEffectLog.create({
        data: {
          id: uuidv4(),
          patientId,
          ...parse.data,
          loggedAt: new Date(),
        },
      })

      return reply.send({ success: true, log })
    }
  )

  /**
   * GET /journey/dashboard
   * Returns full dashboard summary for the patient.
   */
  fastify.get(
    '/journey/dashboard',
    { preHandler: [fastify.authenticate] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const patientId = await getPatientId(req.glpUser.id)
      if (!patientId) return reply.code(404).send({ error: 'Patient profile not found' })

      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

      const [profile, weightLogs, recentInjection, recentSideEffects, nextConsult, activeFlags] =
        await Promise.all([
          prisma.patientProfile.findUnique({
            where: { id: patientId },
            include: {
              assignedDoctor: { select: { fullName: true } },
            },
          }),
          prisma.weightLog.findMany({
            where: { patientId, loggedAt: { gte: thirtyDaysAgo } },
            orderBy: { loggedAt: 'asc' },
          }),
          prisma.injectionLog.findFirst({
            where: { patientId },
            orderBy: { dueAt: 'desc' },
          }),
          prisma.sideEffectLog.findMany({
            where: { patientId, loggedAt: { gte: thirtyDaysAgo } },
            orderBy: { loggedAt: 'desc' },
            take: 5,
          }),
          prisma.consultation.findFirst({
            where: { patientId, status: 'BOOKED', scheduledAt: { gte: new Date() } },
            orderBy: { scheduledAt: 'asc' },
            include: { doctor: { select: { fullName: true } } },
          }),
          prisma.patientFlag.findMany({
            where: { patientId, resolved: false },
          }),
        ])

      // Calculate week number
      const createdAt = profile?.createdAt || new Date()
      const weekNumber = Math.ceil(
        (Date.now() - createdAt.getTime()) / (7 * 24 * 60 * 60 * 1000)
      )

      const startWeight = profile ? parseFloat(profile.startWeightKg.toString()) : 0
      const currentWeight = profile?.currentWeightKg
        ? parseFloat(profile.currentWeightKg.toString())
        : startWeight

      return reply.send({
        profile: {
          fullName: profile?.fullName,
          currentWeightKg: currentWeight,
          startWeightKg: startWeight,
          goalWeightKg: profile?.goalWeightKg
            ? parseFloat(profile.goalWeightKg.toString())
            : null,
          totalLostKg: Math.round((startWeight - currentWeight) * 10) / 10,
          weekNumber,
          assignedDoctor: profile?.assignedDoctor?.fullName,
        },
        weightLogs: weightLogs.map((l) => ({
          date: l.loggedAt,
          weightKg: parseFloat(l.weightKg.toString()),
        })),
        nextInjection: recentInjection
          ? {
              medicineName: recentInjection.medicineName,
              doseMg: parseFloat(recentInjection.doseMg.toString()),
              dueAt: recentInjection.dueAt,
              nextSite: null, // populated by separate call if needed
            }
          : null,
        recentSideEffects,
        nextConsult: nextConsult
          ? {
              scheduledAt: nextConsult.scheduledAt,
              doctorName: nextConsult.doctor.fullName,
            }
          : null,
        activeFlags,
      })
    }
  )
}

// ─── HELPER ───────────────────────────────────────────────

async function getPatientId(userId: string): Promise<string | null> {
  const profile = await prisma.patientProfile.findUnique({
    where: { userId },
    select: { id: true },
  })
  return profile?.id ?? null
}
