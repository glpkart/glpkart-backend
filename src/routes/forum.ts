import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { v4 as uuidv4 } from 'uuid'
import { prisma } from '../lib/prisma'

const CreatePostSchema = z.object({
  title: z.string().min(5).max(200),
  body: z.string().min(10).max(5000),
  topic: z.enum([
    'SIDE_EFFECTS', 'FOOD_AND_EATING', 'SUCCESS_STORIES',
    'DOSING_QUESTIONS', 'MENTAL_HEALTH', 'DOCTOR_ADVICE', 'OTHER'
  ]),
})

const CreateReplySchema = z.object({
  body: z.string().min(5).max(2000),
})

// Auto-moderation: patterns that trigger auto-flag
const AUTO_FLAG_PATTERNS = [
  /\b\d{10}\b/,                          // Phone numbers
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+/,  // Email addresses
  /https?:\/\//i,                         // External links
  /\b(sell|buy|purchase|cheap|discount)\b.*\b(ozempic|mounjaro|semaglutide)\b/i, // Drug sales
]

function autoModerate(text: string): { flagged: boolean; reason?: string } {
  for (const pattern of AUTO_FLAG_PATTERNS) {
    if (pattern.test(text)) {
      return { flagged: true, reason: 'Contains phone number, email, link, or drug sale language' }
    }
  }
  return { flagged: false }
}

export async function forumRoutes(fastify: FastifyInstance) {
  /**
   * GET /forum/posts
   * Public paginated feed. NEVER returns real user IDs — only persona names.
   */
  fastify.get('/forum/posts', async (req: FastifyRequest, reply: FastifyReply) => {
    const { topic, cursor, limit = '20' } = req.query as {
      topic?: string
      cursor?: string
      limit?: string
    }

    const where: Record<string, unknown> = { moderationStatus: 'VISIBLE' }
    if (topic) where.topic = topic.toUpperCase()

    const posts = await prisma.forumPost.findMany({
      where,
      orderBy: [{ isPinned: 'desc' }, { createdAt: 'desc' }],
      take: parseInt(limit),
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        personaName: true,       // ← only persona, never authorId
        title: true,
        body: true,
        topic: true,
        isDoctorPost: true,
        helpfulCount: true,
        isPinned: true,
        createdAt: true,
        // Count of visible replies
        _count: { select: { replies: true } },
      },
    })

    const nextCursor = posts.length === parseInt(limit)
      ? posts[posts.length - 1].id
      : null

    return reply.send({ posts, nextCursor })
  })

  /**
   * GET /forum/posts/:id
   * Single post with replies. No real user IDs exposed.
   */
  fastify.get('/forum/posts/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string }

    const post = await prisma.forumPost.findUnique({
      where: { id },
      select: {
        id: true,
        personaName: true,
        title: true,
        body: true,
        topic: true,
        isDoctorPost: true,
        helpfulCount: true,
        isPinned: true,
        createdAt: true,
        replies: {
          where: { moderationStatus: 'VISIBLE' },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            personaName: true,
            body: true,
            isDoctorReply: true,
            helpfulCount: true,
            createdAt: true,
          },
        },
      },
    })

    if (!post) return reply.code(404).send({ error: 'Post not found' })
    return reply.send({ post })
  })

  /**
   * POST /forum/posts
   * Create a new post. Uses the user's forum persona automatically.
   */
  fastify.post(
    '/forum/posts',
    { preHandler: [fastify.authenticate] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parse = CreatePostSchema.safeParse(req.body)
      if (!parse.success) {
        return reply.code(400).send({ error: parse.error.issues[0].message })
      }

      const user = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: { forumPersona: true },
      })

      if (!user?.forumPersona) {
        return reply.code(400).send({ error: 'Forum persona not set. Please contact support.' })
      }

      const fullText = `${parse.data.title} ${parse.data.body}`
      const modResult = autoModerate(fullText)

      const post = await prisma.forumPost.create({
        data: {
          id: uuidv4(),
          authorId: req.user.id,
          personaName: user.forumPersona,
          title: parse.data.title,
          body: parse.data.body,
          topic: parse.data.topic,
          isDoctorPost: req.user.role === 'DOCTOR',
          moderationStatus: modResult.flagged ? 'FLAGGED' : 'VISIBLE',
        },
        select: {
          id: true,
          personaName: true,
          title: true,
          body: true,
          topic: true,
          createdAt: true,
          moderationStatus: true,
        },
      })

      return reply.code(201).send({
        success: true,
        post,
        ...(modResult.flagged && {
          notice: 'Your post is under review and will appear shortly.',
        }),
      })
    }
  )

  /**
   * POST /forum/posts/:id/reply
   * Reply to a post.
   */
  fastify.post(
    '/forum/posts/:id/reply',
    { preHandler: [fastify.authenticate] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string }
      const parse = CreateReplySchema.safeParse(req.body)
      if (!parse.success) {
        return reply.code(400).send({ error: parse.error.issues[0].message })
      }

      const [post, user] = await Promise.all([
        prisma.forumPost.findUnique({ where: { id }, select: { id: true } }),
        prisma.user.findUnique({
          where: { id: req.user.id },
          select: { forumPersona: true },
        }),
      ])

      if (!post) return reply.code(404).send({ error: 'Post not found' })
      if (!user?.forumPersona) return reply.code(400).send({ error: 'Forum persona not set' })

      const modResult = autoModerate(parse.data.body)

      const newReply = await prisma.forumReply.create({
        data: {
          id: uuidv4(),
          postId: id,
          authorId: req.user.id,
          personaName: user.forumPersona,
          body: parse.data.body,
          isDoctorReply: req.user.role === 'DOCTOR',
          moderationStatus: modResult.flagged ? 'FLAGGED' : 'VISIBLE',
        },
        select: {
          id: true,
          personaName: true,
          body: true,
          isDoctorReply: true,
          createdAt: true,
          moderationStatus: true,
        },
      })

      return reply.code(201).send({ success: true, reply: newReply })
    }
  )

  /**
   * POST /forum/posts/:id/helpful
   * Mark a post as helpful (increment counter).
   */
  fastify.post(
    '/forum/posts/:id/helpful',
    { preHandler: [fastify.authenticate] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string }

      await prisma.forumPost.update({
        where: { id },
        data: { helpfulCount: { increment: 1 } },
      })

      return reply.send({ success: true })
    }
  )

  /**
   * POST /forum/posts/:id/flag
   * Flag a post for moderation review.
   */
  fastify.post(
    '/forum/posts/:id/flag',
    { preHandler: [fastify.authenticate] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string }
      const { reason } = req.body as { reason?: string }

      await prisma.$transaction([
        prisma.forumFlag.create({
          data: {
            id: uuidv4(),
            postId: id,
            flaggedBy: req.user.id,
            reason: reason || 'No reason given',
          },
        }),
        prisma.forumPost.update({
          where: { id },
          data: { flagCount: { increment: 1 } },
        }),
      ])

      // Auto-flag if 3+ reports
      const post = await prisma.forumPost.findUnique({
        where: { id },
        select: { flagCount: true, moderationStatus: true },
      })

      if (post && post.flagCount >= 3 && post.moderationStatus === 'VISIBLE') {
        await prisma.forumPost.update({
          where: { id },
          data: { moderationStatus: 'FLAGGED' },
        })
      }

      return reply.send({ success: true })
    }
  )

  /**
   * GET /forum/my-posts
   * Returns the logged-in user's own posts (with author info for "you" label).
   */
  fastify.get(
    '/forum/my-posts',
    { preHandler: [fastify.authenticate] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const posts = await prisma.forumPost.findMany({
        where: { authorId: req.user.id },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          personaName: true,
          title: true,
          topic: true,
          helpfulCount: true,
          moderationStatus: true,
          createdAt: true,
          _count: { select: { replies: true } },
        },
      })

      return reply.send({ posts })
    }
  )
}
