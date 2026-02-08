import 'dotenv/config'

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason
} from '@whiskeysockets/baileys'

import express from 'express'
import QRCode from 'qrcode'
import bodyParser from 'body-parser'
import rateLimit from 'express-rate-limit'
import axios from 'axios'
import mime from 'mime-types'
import Pino from 'pino'

// ================= CONFIG =================
const app = express()
const PORT = 8000
const API_KEY = process.env.API_KEY

let qrCodeData = null
let sock
let isReady = false

app.use(bodyParser.json())

// ================= RATE LIMIT =================
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 30
}))

// ================= API KEY =================
function authMiddleware(req, res, next) {
  if (req.headers.authorization !== API_KEY) {
    return res.status(403).json({
      status: false,
      message: 'API Key salah'
    })
  }
  next()
}

// ================= BAILEYS =================
async function startWA() {
  const { state, saveCreds } = await useMultiFileAuthState('session')

  sock = makeWASocket({
    auth: state,
    logger: Pino({ level: 'silent' })
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, qr }) => {
    if (qr) {
      qrCodeData = qr
      isReady = false
      console.log('📌 QR tersedia')
    }

    if (connection === 'open') {
      isReady = true
      qrCodeData = null
      console.log('✅ WhatsApp siap')
    }

    if (connection === 'close') {
      isReady = false
      console.log('❌ Koneksi putus, reconnect...')
      startWA()
    }
  })

  // ================= AUTO REPLY =================
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message || msg.key.fromMe) return

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text

    if (text === 'tes') {
      await sock.sendMessage(msg.key.remoteJid, {
        text: 'WhatsApp Baileys Berjalan!'
      })
    }
  })
}

startWA()

// ================= EXPRESS =================
app.get('/qr', async (req, res) => {
  if (isReady) {
    return res.send('<h2>✅ WhatsApp sudah login</h2>')
  }

  if (!qrCodeData) {
    return res.send('<h2>⏳ QR belum tersedia</h2>')
  }

  const img = await QRCode.toDataURL(qrCodeData)
  res.send(`<img src="${img}" />`)
})

// ================= SEND TEXT =================
app.post('/send', authMiddleware, async (req, res) => {
  if (!isReady) {
    return res.status(401).json({
      status: false,
      message: 'WhatsApp belum login'
    })
  }

  const { number, message } = req.body
  const jid = number.replace(/\D/g, '') + '@s.whatsapp.net'

  await sock.sendMessage(jid, { text: message })

  res.json({
    status: true,
    message: 'Pesan terkirim'
  })
})

// ================= SEND FILE =================
app.post('/send-file', authMiddleware, async (req, res) => {
  if (!isReady) {
    return res.status(401).json({
      status: false,
      message: 'WhatsApp belum login'
    })
  }

  const { number, file_url, caption, file_name } = req.body

  if (!number || !file_url) {
    return res.status(400).json({
      status: false,
      message: 'number dan file_url wajib'
    })
  }

  const jid = number.replace(/\D/g, '') + '@s.whatsapp.net'

  try {
    const r = await axios.get(file_url, {
      responseType: 'arraybuffer'
    })

    const buffer = Buffer.from(r.data)
    const type = r.headers['content-type']
    const ext = mime.extension(type) || 'bin'

    const finalFileName =
      file_name ? file_name : `file.${ext}`

    await sock.sendMessage(jid, {
      document: buffer,
      mimetype: type,
      fileName: finalFileName,
      caption: caption || ''
    })

    res.json({
      status: true,
      message: 'File terkirim',
      file_name: finalFileName
    })

  } catch (err) {
    res.status(500).json({
      status: false,
      message: 'Gagal kirim file',
      error: err.message
    })
  }
})

app.post('/send-poll', authMiddleware, async (req, res) => {
  if (!isReady) {
    return res.status(401).json({
      status: false,
      message: 'WhatsApp belum login'
    })
  }

  const { number, question, options, max_answers } = req.body
  const jid = number.replace(/\D/g, '') + '@s.whatsapp.net'

  await sock.sendMessage(jid, {
    poll: {
      name: question,
      values: options,
      selectableCount: max_answers || 1
    }
  })

  res.json({
    status: true,
    message: 'Polling terkirim'
  })
})



app.listen(PORT, () => {
  console.log(`🌐 http://localhost:${PORT}/qr`)
})
