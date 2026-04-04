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
  logger: true,
})

async function bootstrap() {
  await app.register(fastifyCors, {
    origin: true,
    credentials: true,
  })

  await app.register(fastifyJwt, {
    secret: process.env.JWT_SECRET || 'fallback-secret-change-in-production',
  })

  await app.register(fastifyCookie, {
    secret: process.env.JWT_SECRET || 'fallback-secret-change-in-production',
  })

  await app.register(fastifyRateLimit, {
    max: 100,
    timeWindow: '1 minute',
  })

  await app.register(authMiddleware)
  await app.register(authRoutes)
  await app.register(journeyRoutes)
  await app.register(consultationRoutes)
  await app.register(prescriptionRoutes)
  await app.register(forumRoutes)
  await app.register(webhookRoutes)
  await app.register(schedulerRoutes)

  // Health check
  app.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    env: process.env.NODE_ENV,
  }))

  // Root route
  app.get('/', async () => ({
    name: 'GLPKart API',
    status: 'running',
    docs: '/health',
  }))

  // Railway sets PORT dynamically — must listen on 0.0.0.0
  const port = parseInt(process.env.PORT || '3000')
  const host = '0.0.0.0'

  await app.listen({ port, host })
  console.log(`[GLPKart] Server listening on ${host}:${port}`)
  startScheduler()
}

const shutdown = async () => {
  await app.close()
  await prisma.$disconnect()
  if (redis) await redis.quit()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

bootstrap().catch((err) => {
  console.error('[GLPKart] Fatal error:', err)
  process.exit(1)
})
