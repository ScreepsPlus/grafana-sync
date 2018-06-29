const axios = require('axios')
const JWT = require('jsonwebtoken')

const AUTH0_CLIENT_ID = process.env.AUTH0_CLIENT_ID
const AUTH0_CLIENT_SECRET = process.env.AUTH0_CLIENT_SECRET
const GRAFANA_URL = process.env.GRAFANA_URL
const GRAFANA_USERNAME = process.env.GRAFANA_USERNAME
const GRAFANA_PASSWORD = process.env.GRAFANA_PASSWORD
const JWT_ALGORITHM = process.env.JWT_ALGORITHM
const JWT_SECRET = process.env.JWT_SECRET

async function getAuth0 () {
  const { data: { access_token: accessToken, token_type: tokenType } } = await axios.post('https://screepsplus.auth0.com/oauth/token', {
    client_id: AUTH0_CLIENT_ID,
    client_secret: AUTH0_CLIENT_SECRET,
    audience: 'https://screepsplus.auth0.com/api/v2/',
    grant_type: 'client_credentials'
  })
  return axios.create({
    baseURL: 'https://screepsplus.auth0.com',
    headers: {
      Authorization: `${tokenType} ${accessToken}`
    }
  })
}

async function getGrafana () {
  return axios.create({
    baseURL: GRAFANA_URL,
    auth: {
      username: GRAFANA_USERNAME,
      password: GRAFANA_PASSWORD
    }
  })
}

async function run () {
  let auth0 = await getAuth0()
  let grafana = await getGrafana()
  while (true) {
    try {
      await userSyncLoop(auth0, grafana)
    } catch (e) {
      if (e.code === 401) {
        auth0 = await getAuth0()
      } else {
        throw e
      }
    }
    await datasourceLoop(grafana)
    await sleep(10000)
  }
}

const templates = [{
  name: 'ScreepsPlus-Graphite',
  type: 'graphite',
  url: 'https://carbon.ags131.com/',
  access: 'direct',
  readOnly: true,
  jsonData: {
    graphiteVersion: '1.1'
  },
  isDefault: true
}]

const isAdmin = {}

async function datasourceLoop (grafana) {
  const { data: orgs } = await grafana.get('/api/orgs')
  for (const {id, name} of orgs) {
    if (!isAdmin[id]) {
      try {
        await grafana.post(`/api/orgs/${id}/users`, {
          loginOrEmail: GRAFANA_USERNAME,
          role: 'Admin'
        })
        isAdmin[id] = true
      } catch (e) {}
    }
    await grafana.post(`/api/user/using/${id}`)
    const { data: datasources } = await grafana.get('/api/datasources')
    for (const ds of templates) {
      const payload = Object.assign({
        basicAuth: true,
        basicAuthUser: name.toLowerCase(),
        basicAuthPassword: JWT.sign({
          username: name.toLowerCase(),
          scope: ['read:stats']
        }, JWT_SECRET, { algorithm: JWT_ALGORITHM })
      }, ds)
      try {
        const current = datasources.find(d => d.name === ds.name)
        if (!current) {
          await grafana.post('/api/datasources', payload)
        }
      } catch (e) {
        console.error(`Cannot insert datasource ${ds.name} for org ${name} (${id})`, e.message, e.response.data)
      }
    }
  }
}

async function userSyncLoop (auth0, grafana) {
  const { data: users } = await grafana.get('/api/users').catch(e => console.error('grafana', e.message))
  const { data: orgs } = await grafana.get('/api/orgs').catch(e => console.error('grafana', e.message))
  const needsUpdated = users.filter(u => !u.email || !u.email.includes('@') || u.email === u.login)
  if (!needsUpdated.length) return
  console.log(`Updating ${needsUpdated.length} users`)
  for (const { id, email, login } of needsUpdated) {
    console.log(`Attempting to update user ${email}`)
    try {
      const { data: [user] } = await auth0.get('/api/v2/users', {
        params: {
          q: email && email.includes('@') ? `email:"${email}"` : `nickname:"${login}"`
        }
      }).catch(e => console.error('auth0', e.message))
      if (user) {
        const { id: orgid } = orgs.find(o => o.name === email) || {}
        if (orgid) {
          await grafana.put(`/api/orgs/${orgid}`, { name: user.username })
        }
        await grafana.put(`/api/users/${id}`, {
          name: user.username || user.name,
          login: user.username,
          email: user.email
        }).catch(e => console.error('grafana', e.message))
      }
    } catch (e) {
      if (e.code === 429) {
        console.log('Auth0 RateLimited')
        await sleep(1000)
      } else {
        throw e
      }
    }
  }
}

function sleep (time) {
  return new Promise((resolve) => setTimeout(resolve, time))
}

run().catch(console.error)
