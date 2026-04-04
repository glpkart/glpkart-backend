import cron from 'node-cron'
import { prisma } from '../lib/prisma'
import { whatsapp } from '../lib/gupshup'
import { scheduler } from '../lib/redis'
import { v4 as uuidv4 } from 'uuid'

export async function runInjectionReminders() {
  console.log('[Scheduler] Running injection reminders...')
  const twoDaysFromNow = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000)
  const windowStart = new Date(twoDaysFromNow); windowStart.setHours(0,0,0,0)
  const windowEnd = new Date(twoDaysFromNow); windowEnd.setHours(23,59,59,999)

  const injections = await prisma.injectionLog.findMany({
    where: { dueAt: { gte: windowStart, lte: windowEnd }, skipped: false, injectedAt: null },
    include: { patient: { include: { user: { select: { phone: true } } } } },
  })

  let sent = 0
  for (const inj of injections) {
    const key = `injection_reminder:${inj.id}`
    if (await scheduler.wasSent(key)) continue
    try {
      await whatsapp.sendInjectionReminder({
        toPhone: inj.patient.user.phone,
        patientName: inj.patient.fullName,
        medicineName: inj.medicineName,
        daysUntil: 2,
        dueDate: inj.dueAt.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' }),
        dose: `${inj.doseMg} mg`,
        injectionSite: inj.injectionSite.replace(/_/g, ' ').toLowerCase(),
      })
      await scheduler.markSent(key)
      await prisma.notificationLog.create({
        data: { id: uuidv4(), userId: inj.patient.userId, templateName: 'injection_reminder', channel: 'WHATSAPP', status: 'SENT', variables: { injectionId: inj.id } },
      })
      sent++
    } catch (err) { console.error('[Scheduler] injection reminder failed:', err) }
  }
  console.log(`[Scheduler] Injection reminders: ${sent}/${injections.length}`)
}

export async function runConsultReminders() {
  const now = new Date()
  const t10 = new Date(now.getTime() + 10 * 60 * 1000)
  const t11 = new Date(now.getTime() + 11 * 60 * 1000)

  const consults = await prisma.consultation.findMany({
    where: { scheduledAt: { gte: t10, lte: t11 }, status: 'BOOKED', paymentStatus: 'PAID' },
    include: {
      patient: { include: { user: { select: { phone: true } } } },
      doctor: { select: { fullName: true, waPhone: true } },
    },
  })

  for (const c of consults) {
    const key = `consult_10min:${c.id}`
    if (await scheduler.wasSent(key)) continue
    try {
      await whatsapp.sendConsultReminder10Min({
        toPhone: c.patient.user.phone,
        patientName: c.patient.fullName,
        doctorName: c.doctor.fullName,
        doctorWaPhone: c.doctor.waPhone,
      })
      await scheduler.markSent(key)
    } catch (err) { console.error('[Scheduler] consult reminder failed:', err) }
  }
}

export async function runRefillAlerts() {
  console.log('[Scheduler] Running refill alerts...')
  const t8 = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000)
  const windowStart = new Date(t8); windowStart.setHours(0,0,0,0)
  const windowEnd = new Date(t8); windowEnd.setHours(23,59,59,999)

  const subs = await prisma.subscription.findMany({
    where: { status: 'ACTIVE', supplyEndsAt: { gte: windowStart, lte: windowEnd } },
    include: { patient: { include: { user: { select: { phone: true } } } } },
  })

  let sent = 0
  for (const sub of subs) {
    const key = `refill_alert:${sub.id}:${windowStart.toDateString()}`
    if (await scheduler.wasSent(key)) continue
    const cancelBy = new Date(sub.nextRefillDate)
    cancelBy.setDate(cancelBy.getDate() - 2)
    try {
      await whatsapp.sendRefillAlert({
        toPhone: sub.patient.user.phone,
        patientName: sub.patient.fullName,
        medicineName: sub.medicineName,
        daysRemaining: 8,
        refillDate: sub.nextRefillDate.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' }),
        amountRupees: 'as per your plan',
        cancelByDate: cancelBy.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' }),
      })
      await scheduler.markSent(key)
      sent++
    } catch (err) { console.error('[Scheduler] refill alert failed:', err) }
  }
  console.log(`[Scheduler] Refill alerts: ${sent}/${subs.length}`)
}

export async function runWeeklySummaries() {
  console.log('[Scheduler] Running weekly summaries...')
  const patients = await prisma.patientProfile.findMany({
    where: { user: { deletedAt: null } },
    include: {
      user: { select: { phone: true } },
      weightLogs: { orderBy: { loggedAt: 'desc' }, take: 14 },
      injectionLogs: { where: { dueAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } } },
    },
  })

  const weekLabel = new Date().toDateString()
  let sent = 0

  for (const p of patients) {
    const key = `weekly_summary:${p.id}:${weekLabel}`
    if (await scheduler.wasSent(key)) continue
    try {
      const logs = p.weightLogs
      const weekNum = Math.ceil((Date.now() - p.createdAt.getTime()) / (7 * 24 * 60 * 60 * 1000))
      let weightChange = 'No data'
      if (logs.length >= 2) {
        const diff = parseFloat(logs[Math.min(6, logs.length-1)].weightKg.toString()) - parseFloat(logs[0].weightKg.toString())
        weightChange = diff > 0 ? `${diff.toFixed(1)} kg down` : diff < 0 ? `${Math.abs(diff).toFixed(1)} kg up` : 'No change'
      }
      const startW = parseFloat(p.startWeightKg.toString())
      const currW = p.currentWeightKg ? parseFloat(p.currentWeightKg.toString()) : startW
      const taken = p.injectionLogs.filter(i => !i.skipped).length

      await whatsapp.sendWeeklySummary({
        toPhone: p.user.phone, patientName: p.fullName, weekNumber: weekNum,
        weightChange, totalLost: `${(startW - currW).toFixed(1)} kg`,
        injectionsRecord: `${taken} of ${p.injectionLogs.length}`,
        nextInjection: 'check your dashboard', nextConsult: 'check your dashboard',
      })
      await scheduler.markSent(key)
      sent++
    } catch (err) { console.error('[Scheduler] weekly summary failed:', err) }
  }
  console.log(`[Scheduler] Weekly summaries: ${sent}/${patients.length}`)
}

export function startScheduler() {
  cron.schedule('* * * * *',   runConsultReminders,   { timezone: 'Asia/Kolkata' })
  cron.schedule('0 8 * * *',   runInjectionReminders, { timezone: 'Asia/Kolkata' })
  cron.schedule('0 11 * * *',  runRefillAlerts,       { timezone: 'Asia/Kolkata' })
  cron.schedule('0 7 * * 1',   runWeeklySummaries,    { timezone: 'Asia/Kolkata' })
  console.log('[Scheduler] All cron jobs registered (IST)')
}
