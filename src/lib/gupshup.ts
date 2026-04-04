import axios from 'axios'

const BASE_URL = 'https://api.gupshup.io/wa/api/v1/template/msg'

const headers = {
  'Content-Type': 'application/x-www-form-urlencoded',
  apikey: process.env.GUPSHUP_API_KEY!,
}

const APP_NAME = process.env.GUPSHUP_APP_NAME || 'GLPKart'
const SENDER = process.env.GUPSHUP_SENDER_PHONE || '918976026201'
const NAMESPACE = process.env.GUPSHUP_NAMESPACE!

// ─── TEMPLATE NAMES ──────────────────────────────────────

export const TEMPLATES = {
  CONSULT_CONFIRMED: 'consult_confirmed',
  CONSULT_REMINDER_10MIN: 'consult_reminder_10min',
  PRESCRIPTION_READY: 'prescription_ready',
  INJECTION_REMINDER: 'injection_reminder',
  REFILL_ALERT: 'refill_alert',
  WEEKLY_SUMMARY: 'weekly_summary',
} as const

// ─── CORE SEND FUNCTION ───────────────────────────────────

async function sendTemplate(
  toPhone: string,
  templateName: string,
  params: string[]
): Promise<{ success: boolean; msgId?: string; error?: string }> {
  try {
    const message = JSON.stringify({
      type: 'template',
      template: {
        id: templateName,
        params,
      },
    })

    const source = JSON.stringify({
      msgContents: params,
      id: templateName,
    })

    const body = new URLSearchParams({
      channel: 'whatsapp',
      source: SENDER,
      destination: toPhone.replace(/\D/g, ''),
      'src.name': APP_NAME,
      template: message,
      namespace: NAMESPACE,
    })

    const response = await axios.post(BASE_URL, body.toString(), { headers })

    if (response.data?.status === 'submitted') {
      return { success: true, msgId: response.data.messageId }
    }

    return { success: false, error: JSON.stringify(response.data) }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    console.error(`[Gupshup] Failed to send ${templateName}:`, msg)
    return { success: false, error: msg }
  }
}

// ─── TYPED TEMPLATE SENDERS ───────────────────────────────

export const whatsapp = {
  /**
   * Template 1: consult_confirmed
   * "Dear {{1}}, your consultation with {{2}} is confirmed for {{3}} at {{4}} IST..."
   */
  async sendConsultConfirmed(params: {
    toPhone: string
    patientName: string
    doctorName: string
    date: string
    time: string
    bookingId: string
  }) {
    return sendTemplate(params.toPhone, TEMPLATES.CONSULT_CONFIRMED, [
      params.patientName,
      params.doctorName,
      params.date,
      params.time,
      params.bookingId,
    ])
  },

  /**
   * Template 2: consult_reminder_10min
   * "Hi {{1}}, your consultation with {{2}} starts in 10 minutes. The doctor will call you from {{3}}..."
   */
  async sendConsultReminder10Min(params: {
    toPhone: string
    patientName: string
    doctorName: string
    doctorWaPhone: string
  }) {
    return sendTemplate(params.toPhone, TEMPLATES.CONSULT_REMINDER_10MIN, [
      params.patientName,
      params.doctorName,
      params.doctorWaPhone,
    ])
  },

  /**
   * Template 3: prescription_ready
   * "Your prescription from {{1}} is ready on GLPKart. Medicines: {{2}}..."
   */
  async sendPrescriptionReady(params: {
    toPhone: string
    patientName: string
    doctorName: string
    medicineList: string
    rxId: string
  }) {
    return sendTemplate(params.toPhone, TEMPLATES.PRESCRIPTION_READY, [
      params.patientName,
      params.doctorName,
      params.medicineList,
      params.rxId,
    ])
  },

  /**
   * Template 4: injection_reminder
   * "Reminder from GLPKart: Your weekly {{1}} injection is due in {{2}} days on {{3}}..."
   */
  async sendInjectionReminder(params: {
    toPhone: string
    patientName: string
    medicineName: string
    daysUntil: number
    dueDate: string
    dose: string
    injectionSite: string
  }) {
    return sendTemplate(params.toPhone, TEMPLATES.INJECTION_REMINDER, [
      params.patientName,
      params.medicineName,
      String(params.daysUntil),
      params.dueDate,
      params.dose,
      params.injectionSite,
    ])
  },

  /**
   * Template 5: refill_alert
   * "Reminder from GLPKart: Your {{1}} supply runs out in {{2}} days..."
   */
  async sendRefillAlert(params: {
    toPhone: string
    patientName: string
    medicineName: string
    daysRemaining: number
    refillDate: string
    amountRupees: string
    cancelByDate: string
  }) {
    return sendTemplate(params.toPhone, TEMPLATES.REFILL_ALERT, [
      params.patientName,
      params.medicineName,
      String(params.daysRemaining),
      params.refillDate,
      params.amountRupees,
      params.cancelByDate,
    ])
  },

  /**
   * Template 6: weekly_summary
   * "Weekly update from GLPKart: Week {{1}} summary for {{2}}..."
   */
  async sendWeeklySummary(params: {
    toPhone: string
    patientName: string
    weekNumber: number
    weightChange: string   // "0.6 kg down"
    totalLost: string      // "4.2 kg"
    injectionsRecord: string  // "1 of 1"
    nextInjection: string
    nextConsult: string
  }) {
    return sendTemplate(params.toPhone, TEMPLATES.WEEKLY_SUMMARY, [
      params.patientName,
      String(params.weekNumber),
      params.weightChange,
      params.totalLost,
      params.injectionsRecord,
      params.nextInjection,
      params.nextConsult,
    ])
  },
}

// ─── INBOUND MESSAGE PARSER ───────────────────────────────

export type InboundAction = 'SKIP' | 'CANCEL' | 'HELP' | 'UNKNOWN'

export function parseInboundMessage(body: string): InboundAction {
  const text = body.trim().toUpperCase()
  if (text === 'SKIP') return 'SKIP'
  if (text === 'CANCEL') return 'CANCEL'
  if (text === 'HELP') return 'HELP'
  return 'UNKNOWN'
}
