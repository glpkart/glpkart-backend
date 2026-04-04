import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'

// Admin-only endpoint to manually trigger scheduler jobs (for testing)
export async function schedulerRoutes(fastify: FastifyInstance) {
  fastify.post(
    '/admin/scheduler/run/:job',
    { preHandler: [fastify.requireRole(['ADMIN'])] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { job } = req.params as { job: string }
      const { runInjectionReminders, runRefillAlerts, runWeeklySummaries, runConsultReminders } =
        await import('../jobs/scheduler')

      const jobs: Record<string, () => Promise<void>> = {
        injection_reminders: runInjectionReminders,
        refill_alerts: runRefillAlerts,
        weekly_summaries: runWeeklySummaries,
        consult_reminders: runConsultReminders,
      }

      const fn = jobs[job]
      if (!fn) {
        return reply.code(400).send({ error: `Unknown job: ${job}. Valid: ${Object.keys(jobs).join(', ')}` })
      }

      await fn()
      return reply.send({ success: true, job, ranAt: new Date().toISOString() })
    }
  )
}
