import 'dotenv/config'
import makeWASocket, { useMultiFileAuthState } from '@whiskeysockets/baileys'
import express from 'express'
import QRCode from 'qrcode'
import rateLimit from 'express-rate-limit'
import axios from 'axios'
import mime from 'mime-types'
import Pino from 'pino'
import fs from 'fs'
import PQueue from 'p-queue'

// ================= CONFIG =================
const app = express()
const PORT = 8000
const API_KEY = process.env.API_KEY

app.use(express.json())
app.use(rateLimit({ windowMs: 60000, max: 100 }))

// ================= LOGGER =================
const logger = Pino({
  transport: {
    targets: [
      { target: 'pino/file', options: { destination: 'logs/app.log' } },
      { target: 'pino/file', options: { destination: 'logs/error.log', level: 'error' } }
    ]
  }
})

// ================= STORAGE =================
const clients = {}
const qrCodes = {}
const ready = {}
const waNames = []

// ================= QUEUE (ANTI BAN) =================
const queue = new PQueue({
  concurrency: 1,
  interval: 3000,
  intervalCap: 1
})
// ================= AUTH =================
function auth(req, res, next) {
  if (req.headers.authorization !== API_KEY) {
    return res.status(403).json({ status: false, message: 'API Key salah' })
  }
  next()
}

// ================= START WA =================
async function startWA(name) {
  const path = `sessions/${name}`
  if (!fs.existsSync(path)) fs.mkdirSync(path, { recursive: true })

  const { state, saveCreds } = await useMultiFileAuthState(path)

  const sock = makeWASocket({
    auth: state,
    logger: Pino({ level: 'silent' })
  })

  clients[name] = sock
  ready[name] = false
  waNames.push(name)

  sock.ev.on('creds.update', saveCreds)

sock.ev.on('messages.upsert', async ({ messages }) => {
  const msg = messages[0]
  if (!msg.message || msg.key.fromMe) return
  const isGroup = msg.key.remoteJid.endsWith('@g.us')
  const text =
    msg.message.conversation ||
    msg.message.extendedTextMessage?.text ||
    ''

  const payload = {
    session_name: name,
    wa: name,
    from: msg.key.remoteJid,
    to: sock.user.id.split(':')[0] + '@s.whatsapp.net',
    push_name: msg.pushName || '',
    text,
    message_id: msg.key.id,
    timestamp: msg.messageTimestamp,
    is_group: msg.key.remoteJid.endsWith('@g.us'),
    group_id: msg.key.remoteJid.endsWith('@g.us')
      ? msg.key.remoteJid
      : null
  }
  // console.log(text)

  try {
    const res = await axios.post(
      'https://iainkudus.ac.id/wa/store.php',
      payload,
      { timeout: 5000 }
    )

    if (res.data?.status) {
      logger.info({
        wa: name,
        msg_id: msg.key.id,
        db_id: res.data.id,
        status: 'STORED'
      })
    } else {
      logger.warn({
        wa: name,
        msg_id: msg.key.id,
        status: 'FAILED',
        reason: res.data?.message
      })
    }

  } catch (err) {
    logger.error({
      wa: name,
      msg_id: msg.key.id,
      status: 'ERROR',
      error: err.message
    })
  }
})



  sock.ev.on('connection.update', ({ connection, qr }) => {
    if (qr) qrCodes[name] = qr

    if (connection === 'open') {
      ready[name] = true
      delete qrCodes[name]
      logger.info(`${name} READY`)
    }

    if (connection === 'close') {
      ready[name] = false
      logger.error(`${name} DISCONNECTED`)
      setTimeout(() => startWA(name), 5000)
    }
  })
}

// ================= START ALL WA =================
;['tipd','upb','perpus','edok'].forEach(startWA)

// ================= AUTO ROUTING =================
function getAvailableWA() {
  return waNames.find(w => ready[w])
}

// ================= DASHBOARD =================
app.get('/dashboard', (req, res) => {
  const data = waNames.map(w => ({
    wa: w,
    status: ready[w] ? 'ONLINE' : 'OFFLINE'
  }))

  res.json({
    total: waNames.length,
    online: data.filter(d => d.status === 'ONLINE').length,
    data
  })
})

// ================= QR =================
app.get('/qr/:wa', async (req, res) => {
  const wa = req.params.wa

  // WA sudah siap
  if (ready[wa]) {
    return res.json({
      status: true,
      wa,
      ready: true,
      message: 'WhatsApp sudah login'
    })
  }

  // QR belum ada
  if (!qrCodes[wa]) {
    return res.json({
      status: false,
      wa,
      ready: false,
      message: 'QR belum tersedia'
    })
  }

  // Convert QR → base64
  const qrBase64 = await QRCode.toDataURL(qrCodes[wa])

  res.json({
    status: true,
    wa,
    ready: false,
    qr: qrBase64
  })
})

// ================= SEND TEXT =================
import { randomUUID } from 'crypto'

app.post('/send', auth, async (req, res) => {
  const { wa, number, chat_id, message } = req.body
  const selectedWA = wa === 'auto' ? getAvailableWA() : wa

  // ================= VALIDASI =================
  if (!selectedWA || !ready[selectedWA]) {
    return res.status(503).json({
      status: false,
      message: 'WA tidak tersedia / offline'
    })
  }

  if (!message || typeof message !== 'string') {
    return res.status(400).json({
      status: false,
      message: 'message wajib diisi'
    })
  }

  let jid = null

  if (chat_id && typeof chat_id === 'string') {
    // langsung pakai JID (lid / group / personal)
    jid = chat_id
  } else if (number) {
    jid = number.replace(/\D/g, '') + '@s.whatsapp.net'
  } else {
    return res.status(400).json({
      status: false,
      message: 'number atau chat_id wajib diisi'
    })
  }

  // ================= QUEUE =================
  const jobId = randomUUID()

  queue.add(async () => {
    try {
      await clients[selectedWA].sendMessage(jid, { text: message })

      logger.info({
        job_id: jobId,
        wa: selectedWA,
        to: jid,
        status: 'SENT'
      })
    } catch (err) {
      logger.error({
        job_id: jobId,
        wa: selectedWA,
        to: jid,
        status: 'FAILED',
        error: err.message
      })
    }
  })

  // ================= RESPONSE =================
  res.json({
    status: true,
    queued: true,
    job_id: jobId,
    wa: selectedWA,
    to: jid
  })
})


// ================= SEND FILE =================

app.post('/send-file', auth, async (req, res) => {
  const { wa, number, file_url, caption, file_name } = req.body
  const selectedWA = wa === 'auto' ? getAvailableWA() : wa

  if (!selectedWA || !ready[selectedWA]) {
    return res.status(503).json({
      status: false,
      message: 'WA offline'
    })
  }

  if (!number) {
    return res.status(400).json({
      status: false,
      message: 'number wajib'
    })
  }

  const jid = number.includes('@')
    ? number
    : number.replace(/\D/g, '') + '@s.whatsapp.net'

  const jobId = randomUUID()

  queue.add(async () => {
    try {
      const r = await axios.get(file_url, { responseType: 'arraybuffer' })

      await clients[selectedWA].sendMessage(jid, {
        document: Buffer.from(r.data),
        mimetype: r.headers['content-type'],
        fileName: file_name || 'file',
        caption: caption || ''
      })

      logger.info({ jobId, wa: selectedWA, jid, status: 'SENT' })
    } catch (err) {
      logger.error({ jobId, wa: selectedWA, jid, error: err.message })
    }
  })

  // 🔴 RESPONSE LANGSUNG
  res.json({
    status: true,
    queued: true,
    job_id: jobId,
    wa: selectedWA
  })
})

app.listen(PORT, () => {
  console.log(`🚀 WA API RUNNING http://localhost:${PORT}`)
})
