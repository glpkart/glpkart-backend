import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import fp from 'fastify-plugin'
import { tokens } from '../lib/redis'

// Extend FastifyRequest with user context
declare module 'fastify' {
  interface FastifyRequest {
    user: {
      id: string
      role: 'PATIENT' | 'DOCTOR' | 'ADMIN'
      jti: string
    }
  }
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>
    requireRole: (
      roles: Array<'PATIENT' | 'DOCTOR' | 'ADMIN'>
    ) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>
  }
}

export const authMiddleware = fp(async (fastify: FastifyInstance) => {
  // Core authenticate decorator
  fastify.decorate(
    'authenticate',
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        await req.jwtVerify()

        const payload = req.user as { sub: string; role: string; jti: string }

        // Check token blocklist (Redis)
        if (payload.jti) {
          const blocked = await tokens.isBlocked(payload.jti)
          if (blocked) {
            return reply.code(401).send({ error: 'Session expired. Please log in again.' })
          }
        }

        // Normalise user on request
        req.user = {
          id: payload.sub,
          role: payload.role as 'PATIENT' | 'DOCTOR' | 'ADMIN',
          jti: payload.jti,
        }
      } catch (err) {
        return reply.code(401).send({ error: 'Unauthorised. Please log in.' })
      }
    }
  )

  // Role guard decorator factory
  fastify.decorate(
    'requireRole',
    (roles: Array<'PATIENT' | 'DOCTOR' | 'ADMIN'>) =>
      async (req: FastifyRequest, reply: FastifyReply) => {
        await fastify.authenticate(req, reply)
        if (!roles.includes(req.user.role)) {
          return reply.code(403).send({ error: 'You do not have permission to access this resource.' })
        }
      }
  )
})
