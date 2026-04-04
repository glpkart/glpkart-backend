import 'dotenv/config'
import Fastify from 'fastify'
import fastifyCors from '@fastify/cors'
import fastifyJwt from '@fastify/jwt'
import fastifyCookie from '@fastify/cookie'
import fastifyRateLimit from '@fastify/rate-limit'

import { authRoutes } from './routes/auth'
import { journeyRoutes } from './routes/journey'
import { consultationRoutes } from './routes/consultations'
import { prescriptionRoutes } from './routes/prescriptions'
import { forumRoutes } from './routes/forum'
import { webhookRoutes } from './routes/webhooks'
import { schedulerRoutes } from './routes/scheduler'
import { authMiddleware } from './middleware/auth'
import { prisma } from './lib/prisma'
import redis from './lib/redis'
import { startScheduler } from './jobs/scheduler'

const app = Fastify({
  logger: {
    level: process.env.NODE_ENV === 'production' ? 'warn' : 'info',
    transport:
      process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
  },
})

async function bootstrap() {
  // ── Plugins ──────────────────────────────────────────
  await app.register(fastifyCors, {
    origin: [
      process.env.FRONTEND_URL || 'http://localhost:3000',
      'https://glpkart.com',
      'https://www.glpkart.com',
    ],
    credentials: true,
  })

  await app.register(fastifyJwt, {
    secret: process.env.JWT_SECRET!,
  })

  await app.register(fastifyCookie, {
    secret: process.env.JWT_SECRET!,
  })

  await app.register(fastifyRateLimit, {
    max: 100,
    timeWindow: '1 minute',
    keyGenerator: (req) =>
      (req.headers['x-forwarded-for'] as string) || req.ip,
  })

  // ── Auth middleware ───────────────────────────────────
  await app.register(authMiddleware)

  // ── Routes ───────────────────────────────────────────
  await app.register(authRoutes)
  await app.register(journeyRoutes)
  await app.register(consultationRoutes)
  await app.register(prescriptionRoutes)
  await app.register(forumRoutes)
  await app.register(webhookRoutes)
  await app.register(schedulerRoutes)

  // ── Health check ──────────────────────────────────────
  app.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  }))

  // ── Start ─────────────────────────────────────────────
  const port = parseInt(process.env.PORT || '3001')
  await app.listen({ port, host: '0.0.0.0' })
  console.log(`[GLPKart] Backend running on port ${port}`)

  // Start cron jobs
  startScheduler()
}

// Graceful shutdown
const shutdown = async () => {
  console.log('[GLPKart] Shutting down...')
  await app.close()
  await prisma.$disconnect()
  await redis.quit()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

bootstrap().catch((err) => {
  console.error('[GLPKart] Fatal error:', err)
  process.exit(1)
})
