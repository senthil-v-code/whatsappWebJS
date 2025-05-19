const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const qrcodeterminal = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

// Initialize Express app
const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Initialize WhatsApp client
const client = new Client({
    puppeteer: {
        headless: false,
        args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process'
    ]
    }
});

// Store chat data
let chats = [];
let messages = {};

// WhatsApp client events
client.on('qr', (qr) => {
    console.log('QR Code received:', qr);
    qrcode.toDataURL(qr, (err, url) => {
        if (err) {
            console.error('QR Code generation error:', err);
            io.emit('error', { message: 'Failed to generate QR code' });
            return;
        }
        console.log(url);
        io.emit('qr', { url });
        console.log('QR Code generated and emitted to client');
    });
});

client.on('message_create', message => {
	console.log(message.body);
});

client.on('ready', () => {
    console.log('WhatsApp client is ready');
    io.emit('ready');

    // Load chats
    loadChats();
});

client.on('authenticated', () => {
    console.log('WhatsApp client authenticated');
});

client.on('auth_failure', (msg) => {
    console.error('Authentication failed:', msg);
    io.emit('auth_failure', { message: msg });
});

client.on('disconnected', (reason) => {
    console.log('WhatsApp client disconnected:', reason);
    io.emit('disconnected', { reason });
});

// Message handling
client.on('message', async (msg) => {
    console.log('Message received:', msg.body);

    // Get chat info
    const chat = await msg.getChat();

    // Store message
    if (!messages[chat.id._serialized]) {
        messages[chat.id._serialized] = [];
    }

    const messageData = {
        id: msg.id.id,
        body: msg.body,
        from: msg.from,
        timestamp: msg.timestamp,
        fromMe: msg.fromMe,
        author: msg.author || msg.from
    };

    messages[chat.id._serialized].push(messageData);

    // Emit new message event
    io.emit('message', {
        chatId: chat.id._serialized,
        message: messageData
    });

    // Notification for new message
    if (!msg.fromMe) {
        io.emit('notification', {
            chatId: chat.id._serialized,
            message: messageData
        });
    }
});

// Load all chats
async function loadChats() {
    try {
        chats = await client.getChats();
        const chatList = chats.map(chat => ({
            id: chat.id._serialized,
            name: chat.name,
            isGroup: chat.isGroup,
            timestamp: chat.timestamp,
            unreadCount: chat.unreadCount,
            lastMessage: chat.lastMessage ? chat.lastMessage.body : ''
        }));

        io.emit('chats', { chats: chatList });

        // Load messages for each chat
        for (const chat of chats) {
            try {
                const chatMessages = await chat.fetchMessages({ limit: 100 });
                messages[chat.id._serialized] = chatMessages.map(msg => ({
                    id: msg.id.id,
                    body: msg.body,
                    from: msg.from,
                    timestamp: msg.timestamp,
                    fromMe: msg.fromMe,
                    author: msg.author || msg.from
                }));
            } catch (err) {
                console.error(`Error loading messages for chat ${chat.id._serialized}:`, err);
            }
        }
    } catch (err) {
        console.error('Error loading chats:', err);
    }
}

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log('🔌 New socket client connected');
    if (client.info) {
        socket.emit('ready');

        // Send existing chats and messages
        const chatList = chats.map(chat => ({
            id: chat.id._serialized,
            name: chat.name,
            isGroup: chat.isGroup,
            timestamp: chat.timestamp,
            unreadCount: chat.unreadCount,
            lastMessage: chat.lastMessage ? chat.lastMessage.body : ''
        }));

        socket.emit('chats', { chats: chatList });
    }

    // Handle get messages request
    socket.on('getMessages', async ({ chatId }) => {
        if (messages[chatId]) {
            socket.emit('messages', {
                chatId,
                messages: messages[chatId]
            });
        } else {
            const chat = chats.find(c => c.id._serialized === chatId);
            if (chat) {
                try {
                    const chatMessages = await chat.fetchMessages({ limit: 50 });
                    messages[chatId] = chatMessages.map(msg => ({
                        id: msg.id.id,
                        body: msg.body,
                        from: msg.from,
                        timestamp: msg.timestamp,
                        fromMe: msg.fromMe,
                        author: msg.author || msg.from
                    }));

                    socket.emit('messages', {
                        chatId,
                        messages: messages[chatId]
                    });
                } catch (err) {
                    console.error(`Error fetching messages for chat ${chatId}:`, err);
                    socket.emit('error', { message: 'Failed to fetch messages' });
                }
            }
        }
    });

    // Handle send message
    socket.on('sendMessage', async ({ chatId, message }) => {
        try {
            const chat = chats.find(c => c.id._serialized === chatId);
            if (chat) {
                await chat.sendMessage(message);
                socket.emit('messageSent', { chatId, status: 'success' });
            } else {
                socket.emit('error', { message: 'Chat not found' });
            }
        } catch (err) {
            console.error('Error sending message:', err);
            socket.emit('error', { message: 'Failed to send message' });
        }
    });

    // Handle broadcast message
    socket.on('broadcast', async ({ recipients, message }) => {
        try {
            const results = [];

            for (const recipient of recipients) {
                try {
                    const chat = chats.find(c => c.id._serialized === recipient);
                    if (chat) {
                        await chat.sendMessage(message);
                        results.push({ chatId: recipient, status: 'success' });
                    } else {
                        results.push({ chatId: recipient, status: 'failed', reason: 'Chat not found' });
                    }
                } catch (err) {
                    console.error(`Error broadcasting to ${recipient}:`, err);
                    results.push({ chatId: recipient, status: 'failed', reason: err.message });
                }
            }

            socket.emit('broadcastResults', { results });
        } catch (err) {
            console.error('Error broadcasting messages:', err);
            socket.emit('error', { message: 'Failed to broadcast message' });
        }
    });

    socket.on('disconnect', () => {
        console.log('❌ Client disconnected');
    });
});

// API Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start WhatsApp client
client.initialize()
    .catch(err => {
        console.error('Failed to initialize WhatsApp client:', err);
    });

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});