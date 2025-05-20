const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

// Initialize Express app
const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

let isClientReady = false;

// Initialize WhatsApp client
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-gpu',
            '--disable-dev-shm-usage',
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
    qrcode.toDataURL(qr, (err, url) => {
        if (err) {
            console.error('QR Code generation error:', err);
            io.emit('error', { message: 'Failed to generate QR code' });
            return;
        }
        io.emit('qr', { url });
    });
});

client.on('message_create', message => {
    console.log(message.body);
});

client.on('ready', () => {
    isClientReady = true;
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
    isClientReady = false;
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
    if (isClientReady) {
        socket.emit('ready');
        
        // Send existing chats
        const chatList = chats.map(chat => ({
            id: chat.id._serialized,
            name: chat.name,
            isGroup: chat.isGroup,
            timestamp: chat.timestamp,
            unreadCount: chat.unreadCount,
            lastMessage: chat.lastMessage ? chat.lastMessage.body : ''
        }));
        
        socket.emit('chats', { chats: chatList });

        // If there was an active chat before refresh, send its messages
        if (socket.handshake.query.lastChatId) {
            const lastChatId = socket.handshake.query.lastChatId;
            if (messages[lastChatId]) {
                socket.emit('messages', {
                    chatId: lastChatId,
                    messages: messages[lastChatId]
                });
            }
        }
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
                    console.log(`Fetched ${chatMessages.length} messages for chat ${chatId}`);
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
                await client.isRegisteredUser(chatId);
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

app.post('/api/send-message', async (req, res) => {
    const { phone, message } = req.body;

    if (!isClientReady) {
        return res.status(503).json({ success: false, error: 'WhatsApp client is not ready yet' });
    }

    if (!phone || !message) {
        return res.status(400).json({ success: false, error: 'phone and message are required' });
    }

    const chatId = `${phone}@c.us`;

    try {
        const isRegistered = await client.isRegisteredUser(chatId);
        if (!isRegistered) {
            return res.status(400).json({ success: false, error: 'Number is not on WhatsApp' });
        }

        await client.sendMessage(chatId, message);
        return res.status(200).json({ success: true, message: 'Message sent successfully' });
    } catch (error) {
        console.error('Send message failed:', error);
        return res.status(500).json({ success: false, error: 'Failed to send message', details: error.message });
    }
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
