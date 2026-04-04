const fastify = require('fastify')({ logger: true })

fastify.get('/', async () => ({ name: 'GLPKart API', status: 'running' }))
fastify.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }))

// Use Railway's PORT — do not hardcode
const PORT = parseInt(process.env.PORT || '8080')

fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) { console.error(err); process.exit(1) }
  console.log('GLPKart API running on port ' + PORT)
})
