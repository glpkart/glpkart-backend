import Redis from 'ioredis'

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
})

redis.on('error', (err) => {
  console.error('[Redis] Connection error:', err.message)
})

redis.on('connect', () => {
  console.log('[Redis] Connected')
})

// ─── OTP HELPERS ─────────────────────────────────────────

const OTP_TTL = 5 * 60        // 5 minutes
const OTP_RATE_TTL = 10 * 60  // 10 minutes window
const OTP_RATE_MAX = 3         // max 3 OTPs per window

export const otp = {
  async set(phone: string, code: string): Promise<void> {
    await redis.setex(`otp:${phone}`, OTP_TTL, code)
  },

  async get(phone: string): Promise<string | null> {
    return redis.get(`otp:${phone}`)
  },

  async del(phone: string): Promise<void> {
    await redis.del(`otp:${phone}`)
  },

  async checkRateLimit(phone: string): Promise<{ allowed: boolean; attemptsLeft: number }> {
    const key = `otp_rate:${phone}`
    const count = await redis.incr(key)
    if (count === 1) await redis.expire(key, OTP_RATE_TTL)
    return {
      allowed: count <= OTP_RATE_MAX,
      attemptsLeft: Math.max(0, OTP_RATE_MAX - count),
    }
  },
}

// ─── JWT TOKEN BLOCKLIST ──────────────────────────────────

export const tokens = {
  async block(jti: string, ttlSeconds: number): Promise<void> {
    await redis.setex(`blocked:${jti}`, ttlSeconds, '1')
  },

  async isBlocked(jti: string): Promise<boolean> {
    return (await redis.get(`blocked:${jti}`)) === '1'
  },
}

// ─── GENERAL RATE LIMITING ────────────────────────────────

export const rateLimit = {
  async check(
    key: string,
    limit: number,
    windowSecs: number
  ): Promise<{ allowed: boolean; count: number }> {
    const rKey = `rate:${key}`
    const count = await redis.incr(rKey)
    if (count === 1) await redis.expire(rKey, windowSecs)
    return { allowed: count <= limit, count }
  },
}

// ─── SCHEDULER STATE ─────────────────────────────────────
// Prevents duplicate notifications when cron runs multiple instances

export const scheduler = {
  async markSent(key: string, ttlSeconds = 86400): Promise<void> {
    await redis.setex(`notif_sent:${key}`, ttlSeconds, '1')
  },

  async wasSent(key: string): Promise<boolean> {
    return (await redis.get(`notif_sent:${key}`)) === '1'
  },
}

// ─── IDEMPOTENCY KEYS ────────────────────────────────────

export const idempotency = {
  async set(key: string, result: unknown, ttlSeconds = 3600): Promise<void> {
    await redis.setex(`idempotent:${key}`, ttlSeconds, JSON.stringify(result))
  },

  async get<T>(key: string): Promise<T | null> {
    const val = await redis.get(`idempotent:${key}`)
    return val ? (JSON.parse(val) as T) : null
  },
}

export default redis
