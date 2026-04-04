import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { v4 as uuidv4 } from 'uuid'
import { prisma } from '../lib/prisma'
import { whatsapp } from '../lib/gupshup'

const IssuePrescriptionSchema = z.object({
  consultationId: z.string().uuid().optional(),
  patientId: z.string().uuid(),
  medicines: z.array(z.object({
    name: z.string().min(1),
    dose: z.string().min(1),
    frequency: z.string().min(1),
    quantity: z.string().min(1),
    instructions: z.string().optional(),
  })).min(1),
  notes: z.string().optional(),
  validDays: z.number().int().min(30).max(365).default(90),
})

function generateRxNumber(): string {
  const date = new Date()
  const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '')
  const random = Math.floor(1000 + Math.random() * 9000)
  return `SS-RX-${dateStr}-${random}`
}

export async function prescriptionRoutes(fastify: FastifyInstance) {
  /**
   * POST /prescriptions
   * Doctor issues a prescription. Fires prescription_ready WhatsApp to patient.
   */
  fastify.post(
    '/prescriptions',
    { preHandler: [fastify.requireRole(['DOCTOR'])] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parse = IssuePrescriptionSchema.safeParse(req.body)
      if (!parse.success) {
        return reply.code(400).send({ error: parse.error.issues[0].message })
      }

      const { consultationId, patientId, medicines, notes, validDays } = parse.data

      // Get doctor
      const doctor = await prisma.doctor.findUnique({
        where: { userId: req.user.id },
      })
      if (!doctor) return reply.code(403).send({ error: 'Doctor profile not found' })

      // Get patient with phone
      const patient = await prisma.patientProfile.findUnique({
        where: { id: patientId },
        include: { user: { select: { phone: true } } },
      })
      if (!patient) return reply.code(404).send({ error: 'Patient not found' })

      const validUntil = new Date()
      validUntil.setDate(validUntil.getDate() + validDays)

      const prescription = await prisma.prescription.create({
        data: {
          id: uuidv4(),
          rxNumber: generateRxNumber(),
          patientId,
          doctorId: doctor.id,
          consultationId: consultationId || null,
          medicines,
          notes: notes || null,
          validUntil,
          issuedAt: new Date(),
        },
      })

      // Build medicine list string for WhatsApp
      const medicineList = (medicines as Array<{name: string; dose: string}>)
        .map((m) => `${m.name} ${m.dose}`)
        .join(', ')

      // Fire prescription_ready WhatsApp
      try {
        await whatsapp.sendPrescriptionReady({
          toPhone: patient.user.phone,
          patientName: patient.fullName,
          doctorName: doctor.fullName,
          medicineList,
          rxId: prescription.rxNumber,
        })

        await prisma.notificationLog.create({
          data: {
            id: uuidv4(),
            userId: patient.userId,
            templateName: 'prescription_ready',
            channel: 'WHATSAPP',
            status: 'SENT',
            variables: { patientName: patient.fullName, medicineList, rxId: prescription.rxNumber },
          },
        })
      } catch (err) {
        console.error('[Prescription] Failed to send WhatsApp:', err)
        // Don't fail the request — prescription is still created
      }

      return reply.code(201).send({
        success: true,
        prescription: {
          id: prescription.id,
          rxNumber: prescription.rxNumber,
          validUntil: prescription.validUntil,
          medicines: prescription.medicines,
        },
      })
    }
  )

  /**
   * GET /prescriptions
   * Patient gets their prescription history. Doctor gets their issued prescriptions.
   */
  fastify.get(
    '/prescriptions',
    { preHandler: [fastify.authenticate] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      let where: Record<string, unknown> = {}

      if (req.user.role === 'PATIENT') {
        const patient = await prisma.patientProfile.findUnique({
          where: { userId: req.user.id },
          select: { id: true },
        })
        if (!patient) return reply.code(404).send({ error: 'Patient not found' })
        where = { patientId: patient.id }
      } else if (req.user.role === 'DOCTOR') {
        const doctor = await prisma.doctor.findUnique({
          where: { userId: req.user.id },
          select: { id: true },
        })
        if (!doctor) return reply.code(404).send({ error: 'Doctor not found' })
        where = { doctorId: doctor.id }
      }

      const prescriptions = await prisma.prescription.findMany({
        where,
        orderBy: { issuedAt: 'desc' },
        include: {
          doctor: { select: { fullName: true } },
          patient: { select: { fullName: true } },
        },
      })

      return reply.send({ prescriptions })
    }
  )

  /**
   * GET /prescriptions/:id
   * Get a single prescription by ID.
   */
  fastify.get(
    '/prescriptions/:id',
    { preHandler: [fastify.authenticate] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string }

      const prescription = await prisma.prescription.findUnique({
        where: { id },
        include: {
          doctor: { select: { fullName: true, qualification: true, mciNumber: true } },
          patient: { select: { fullName: true } },
        },
      })

      if (!prescription) return reply.code(404).send({ error: 'Prescription not found' })

      return reply.send({ prescription })
    }
  )
}
