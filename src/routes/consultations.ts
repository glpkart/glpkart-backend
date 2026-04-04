import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { v4 as uuidv4 } from 'uuid'
import axios from 'axios'
import { prisma } from '../lib/prisma'

const BookConsultSchema = z.object({
  doctorId: z.string().uuid(),
  scheduledAt: z.string().datetime(),
})

const UpdateNotesSchema = z.object({
  notes: z.string().min(1),
  doseDecision: z.enum(['CONTINUE', 'STEP_UP', 'REDUCE', 'STOP']).optional(),
  nextConsultDate: z.string().datetime().optional(),
  labRecommendation: z.string().optional(),
})

async function createRazorpayOrder(amountPaise: number, consultId: string) {
  const response = await axios.post(
    'https://api.razorpay.com/v1/orders',
    {
      amount: amountPaise,
      currency: 'INR',
      receipt: `consult_${consultId.slice(0, 8)}`,
    },
    {
      auth: {
        username: process.env.RAZORPAY_KEY_ID!,
        password: process.env.RAZORPAY_KEY_SECRET!,
      },
    }
  )
  return response.data.id as string
}

export async function consultationRoutes(fastify: FastifyInstance) {
  /**
   * GET /consultations/slots/:doctorId
   * Returns available slots for a doctor on a given date.
   */
  fastify.get(
    '/consultations/slots/:doctorId',
    { preHandler: [fastify.authenticate] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { doctorId } = req.params as { doctorId: string }
      const { date } = req.query as { date?: string }

      const targetDate = date ? new Date(date) : new Date()
      const dayOfWeek = targetDate.getDay()

      const availability = await prisma.doctorAvailability.findFirst({
        where: { doctorId, dayOfWeek, isActive: true },
      })

      if (!availability) {
        return reply.send({ slots: [], message: 'Doctor not available on this day' })
      }

      // Generate 30-min slots
      const slots: { time: string; available: boolean }[] = []
      for (let h = availability.startHour; h < availability.endHour; h++) {
        for (const m of [0, 30]) {
          const slotTime = new Date(targetDate)
          slotTime.setHours(h, m, 0, 0)

          // Check if slot is booked
          const booked = await prisma.consultation.findFirst({
            where: {
              doctorId,
              scheduledAt: slotTime,
              status: { in: ['BOOKED'] },
            },
          })

          slots.push({
            time: slotTime.toISOString(),
            available: !booked,
          })
        }
      }

      return reply.send({ slots })
    }
  )

  /**
   * POST /consultations
   * Book a consultation — creates Razorpay order.
   */
  fastify.post(
    '/consultations',
    { preHandler: [fastify.authenticate] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parse = BookConsultSchema.safeParse(req.body)
      if (!parse.success) {
        return reply.code(400).send({ error: parse.error.issues[0].message })
      }

      const { doctorId, scheduledAt } = parse.data

      const patient = await prisma.patientProfile.findUnique({
        where: { userId: req.glpUser.id },
      })
      if (!patient) return reply.code(404).send({ error: 'Patient profile not found' })

      const doctor = await prisma.doctor.findUnique({ where: { id: doctorId } })
      if (!doctor) return reply.code(404).send({ error: 'Doctor not found' })

      // Check slot availability
      const slotTaken = await prisma.consultation.findFirst({
        where: {
          doctorId,
          scheduledAt: new Date(scheduledAt),
          status: 'BOOKED',
        },
      })
      if (slotTaken) {
        return reply.code(409).send({ error: 'This slot is no longer available. Please choose another time.' })
      }

      const consultId = uuidv4()
      const amountPaise = 79900 // ₹799

      // Create Razorpay order
      let razorpayOrderId: string | undefined
      try {
        razorpayOrderId = await createRazorpayOrder(amountPaise, consultId)
      } catch (err) {
        return reply.code(500).send({ error: 'Payment gateway error. Please try again.' })
      }

      const consultation = await prisma.consultation.create({
        data: {
          id: consultId,
          patientId: patient.id,
          doctorId,
          scheduledAt: new Date(scheduledAt),
          status: 'BOOKED',
          amountPaise,
          razorpayOrderId,
          paymentStatus: 'PENDING',
        },
        include: {
          doctor: { select: { fullName: true, waPhone: true } },
        },
      })

      return reply.code(201).send({
        consultationId: consultation.id,
        razorpayOrderId,
        amountPaise,
        razorpayKeyId: process.env.RAZORPAY_KEY_ID,
        doctor: consultation.doctor,
      })
    }
  )

  /**
   * GET /consultations
   * List consultations for the logged-in patient (or doctor).
   */
  fastify.get(
    '/consultations',
    { preHandler: [fastify.authenticate] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { status, limit = '10' } = req.query as { status?: string; limit?: string }

      let where: Record<string, unknown> = {}

      if (req.glpUser.role === 'PATIENT') {
        const patient = await prisma.patientProfile.findUnique({
          where: { userId: req.glpUser.id },
        })
        if (!patient) return reply.code(404).send({ error: 'Patient not found' })
        where = { patientId: patient.id }
      } else if (req.glpUser.role === 'DOCTOR') {
        const doctor = await prisma.doctor.findUnique({
          where: { userId: req.glpUser.id },
        })
        if (!doctor) return reply.code(404).send({ error: 'Doctor not found' })
        where = { doctorId: doctor.id }
      }

      if (status) where.status = status.toUpperCase()

      const consultations = await prisma.consultation.findMany({
        where,
        orderBy: { scheduledAt: 'desc' },
        take: parseInt(limit),
        include: {
          doctor: { select: { fullName: true } },
          patient: { select: { fullName: true } },
        },
      })

      return reply.send({ consultations })
    }
  )

  /**
   * PATCH /consultations/:id/notes
   * Doctor saves post-consult notes and dose decision.
   */
  fastify.patch(
    '/consultations/:id/notes',
    { preHandler: [fastify.requireRole(['DOCTOR'])] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string }
      const parse = UpdateNotesSchema.safeParse(req.body)
      if (!parse.success) {
        return reply.code(400).send({ error: parse.error.issues[0].message })
      }

      const consultation = await prisma.consultation.update({
        where: { id },
        data: {
          ...parse.data,
          status: 'COMPLETED',
          nextConsultDate: parse.data.nextConsultDate
            ? new Date(parse.data.nextConsultDate)
            : undefined,
        },
      })

      return reply.send({ success: true, consultation })
    }
  )

  /**
   * GET /consultations/:id/preread
   * Doctor fetches assembled pre-consult view for a patient.
   */
  fastify.get(
    '/consultations/:id/preread',
    { preHandler: [fastify.requireRole(['DOCTOR'])] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string }

      const consultation = await prisma.consultation.findUnique({
        where: { id },
        include: {
          patient: {
            include: {
              medicalHistory: true,
              weightLogs: {
                orderBy: { loggedAt: 'desc' },
                take: 30,
              },
              injectionLogs: {
                orderBy: { dueAt: 'desc' },
                take: 5,
              },
              sideEffectLogs: {
                orderBy: { loggedAt: 'desc' },
                take: 10,
              },
              labResults: {
                orderBy: { collectedAt: 'desc' },
                take: 3,
              },
              patientFlags: {
                where: { resolved: false },
              },
            },
          },
        },
      })

      if (!consultation) return reply.code(404).send({ error: 'Consultation not found' })

      // Get past consult notes
      const pastConsults = await prisma.consultation.findMany({
        where: {
          patientId: consultation.patientId,
          status: 'COMPLETED',
          id: { not: id },
        },
        orderBy: { scheduledAt: 'desc' },
        take: 3,
        select: { scheduledAt: true, notes: true, doseDecision: true },
      })

      return reply.send({
        consultation,
        pastConsults,
      })
    }
  )
}
