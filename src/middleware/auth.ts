import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import fp from 'fastify-plugin'
import { tokens } from '../lib/redis'

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; role: string; jti: string; type?: string }
    user: { sub: string; role: string; jti: string; type?: string }
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    glpUser: {
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
  fastify.decorate(
    'authenticate',
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        await req.jwtVerify()
        const payload = req.user as { sub: string; role: string; jti: string }
        if (payload.jti) {
          const blocked = await tokens.isBlocked(payload.jti)
          if (blocked) return reply.code(401).send({ error: 'Session expired. Please log in again.' })
        }
        req.glpUser = {
          id: payload.sub,
          role: payload.role as 'PATIENT' | 'DOCTOR' | 'ADMIN',
          jti: payload.jti,
        }
      } catch {
        return reply.code(401).send({ error: 'Unauthorised. Please log in.' })
      }
    }
  )

  fastify.decorate(
    'requireRole',
    (roles: Array<'PATIENT' | 'DOCTOR' | 'ADMIN'>) =>
      async (req: FastifyRequest, reply: FastifyReply) => {
        await fastify.authenticate(req, reply)
        if (!roles.includes(req.glpUser.role)) {
          return reply.code(403).send({ error: 'Access denied.' })
        }
      }
  )
})
