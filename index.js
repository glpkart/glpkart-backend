const fastify = require('fastify')({ logger: true })

fastify.get('/', async () => ({ name: 'GLPKart API', status: 'running' }))
fastify.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }))

const port = parseInt(process.env.PORT || '3000')
fastify.listen({ port, host: '0.0.0.0' }, (err) => {
  if (err) { console.error(err); process.exit(1) }
  console.log(`GLPKart running on port ${port}`)
})
