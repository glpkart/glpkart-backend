import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { prisma } from '../lib/prisma'
import { parseInboundMessage } from '../lib/gupshup'

interface GupshupWebhookBody {
  app?: string
  timestamp?: number
  version?: number
  type?: string
  payload?: {
    type?: string
    payload?: {
      text?: string
    }
    sender?: {
      phone?: string
      name?: string
    }
  }
}

export async function webhookRoutes(fastify: FastifyInstance) {
  /**
   * POST /webhooks/gupshup
   * Receives inbound WhatsApp messages from patients.
   * Handles: SKIP (cancel refill), CANCEL (reschedule consult), HELP (support)
   */
  fastify.post('/webhooks/gupshup', async (req: FastifyRequest, reply: FastifyReply) => {
    // Gupshup expects a 200 OK quickly — process asynchronously
    reply.send({ status: 'ok' })

    const body = req.body as GupshupWebhookBody

    try {
      const senderPhone = body?.payload?.sender?.phone
      const messageText = body?.payload?.payload?.text

      if (!senderPhone || !messageText) return

      // Normalise phone (remove country code prefix if present)
      const phone = senderPhone.replace(/^91/, '').replace(/\D/g, '')
      if (phone.length !== 10) return

      const action = parseInboundMessage(messageText)
      console.log(`[Webhook/Gupshup] ${phone} sent: ${messageText} → action: ${action}`)

      const user = await prisma.user.findUnique({
        where: { phone },
        include: { patientProfile: true },
      })

      if (!user || !user.patientProfile) return

      const patientId = user.patientProfile.id

      switch (action) {
        case 'SKIP': {
          // Cancel the next scheduled auto-refill for this patient
          const nextRefill = await prisma.subscription.findFirst({
            where: { patientId, status: 'ACTIVE' },
            orderBy: { nextRefillDate: 'asc' },
          })
          if (nextRefill) {
            // Move next refill date forward by one cycle
            const nextDate = new Date(nextRefill.nextRefillDate)
            nextDate.setDate(nextDate.getDate() + nextRefill.frequencyDays)
            await prisma.subscription.update({
              where: { id: nextRefill.id },
              data: { nextRefillDate: nextDate },
            })
            console.log(`[Webhook/Gupshup] Refill skipped for patient ${patientId}`)
          }
          break
        }

        case 'CANCEL': {
          // Cancel the next upcoming consultation
          const nextConsult = await prisma.consultation.findFirst({
            where: {
              patientId,
              status: 'BOOKED',
              scheduledAt: { gte: new Date() },
            },
            orderBy: { scheduledAt: 'asc' },
          })
          if (nextConsult) {
            await prisma.consultation.update({
              where: { id: nextConsult.id },
              data: { status: 'CANCELLED' },
            })
            console.log(`[Webhook/Gupshup] Consult cancelled for patient ${patientId}`)
            // TODO: trigger refund via Razorpay if payment was made
          }
          break
        }

        case 'HELP': {
          // Create a support ticket / flag for admin
          await prisma.patientFlag.create({
            data: {
              id: require('uuid').v4(),
              patientId,
              flagType: 'support_request',
              severity: 'warning',
              data: { message: messageText, source: 'whatsapp' },
            },
          })
          console.log(`[Webhook/Gupshup] Support request logged for patient ${patientId}`)
          break
        }

        default:
          // Unknown message — log it but take no action
          console.log(`[Webhook/Gupshup] Unknown message from ${phone}: ${messageText}`)
      }
    } catch (err) {
      console.error('[Webhook/Gupshup] Error processing inbound message:', err)
    }
  })

  /**
   * POST /webhooks/razorpay
   * Handles Razorpay payment events.
   * On payment.captured: marks consultation paid and fires consult_confirmed WhatsApp.
   */
  fastify.post('/webhooks/razorpay', async (req: FastifyRequest, reply: FastifyReply) => {
    // Verify Razorpay signature
    const signature = (req.headers as Record<string, string>)['x-razorpay-signature']
    if (!signature) {
      return reply.code(400).send({ error: 'Missing signature' })
    }

    const crypto = require('crypto')
    const body = JSON.stringify(req.body)
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET!)
      .update(body)
      .digest('hex')

    if (signature !== expectedSignature) {
      console.warn('[Webhook/Razorpay] Invalid signature')
      return reply.code(400).send({ error: 'Invalid signature' })
    }

    reply.send({ status: 'ok' })

    const event = req.body as { event: string; payload: { payment: { entity: Record<string, unknown> } } }

    try {
      if (event.event === 'payment.captured') {
        const payment = event.payload.payment.entity
        const razorpayOrderId = payment['order_id'] as string
        const razorpayPaymentId = payment['id'] as string

        // Find consultation by Razorpay order ID
        const consultation = await prisma.consultation.findFirst({
          where: { razorpayOrderId },
          include: {
            patient: {
              include: {
                user: { select: { phone: true } },
              },
            },
            doctor: { select: { fullName: true } },
          },
        })

        if (!consultation) {
          console.warn(`[Webhook/Razorpay] No consultation found for order ${razorpayOrderId}`)
          return
        }

        // Mark as paid
        await prisma.consultation.update({
          where: { id: consultation.id },
          data: {
            paymentStatus: 'PAID',
            razorpayPaymentId,
          },
        })

        // Fire consult_confirmed WhatsApp
        const { whatsapp: wa } = await import('../lib/gupshup')
        const patientPhone = consultation.patient.user.phone
        const scheduledAt = new Date(consultation.scheduledAt)

        await wa.sendConsultConfirmed({
          toPhone: patientPhone,
          patientName: consultation.patient.fullName,
          doctorName: consultation.doctor.fullName,
          date: scheduledAt.toLocaleDateString('en-IN', {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            year: 'numeric',
          }),
          time: scheduledAt.toLocaleTimeString('en-IN', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: true,
          }),
          bookingId: `GK-${consultation.id.slice(0, 8).toUpperCase()}`,
        })

        // Log notification
        await prisma.notificationLog.create({
          data: {
            id: require('uuid').v4(),
            userId: consultation.patient.userId,
            templateName: 'consult_confirmed',
            channel: 'WHATSAPP',
            status: 'SENT',
            variables: {
              patientName: consultation.patient.fullName,
              doctorName: consultation.doctor.fullName,
              scheduledAt: consultation.scheduledAt,
            },
          },
        })

        console.log(`[Webhook/Razorpay] Payment captured for consultation ${consultation.id}`)
      }
    } catch (err) {
      console.error('[Webhook/Razorpay] Error processing payment event:', err)
    }
  })
}
