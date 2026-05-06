require('dotenv').config();
const { startWhatsappBot } = require('./services/whatsappService');

console.log('[APP] Iniciando chatbot de préstamos...');
startWhatsappBot();
