const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Datastore = require('@seald-io/nedb');
const bcrypt = require('bcryptjs');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Konfiguracja zapisu plików
const upload = multer({ dest: 'uploads/' });
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

const usersDB = new Datastore({ filename: path.join(__dirname, 'users.db'), autoload: true });
const friendsDB = new Datastore({ filename: path.join(__dirname, 'friends.db'), autoload: true });
const filesDB = new Datastore({ filename: path.join(__dirname, 'files.db'), autoload: true });

app.use(express.static(path.join(__dirname, 'public')));

// Endpoint do wysyłania plików
app.post('/upload', upload.single('file'), (req, res) => {
    const { owner, ownerId } = req.body;
    const fileData = {
        name: req.file.originalname,
        path: req.file.path,
        size: req.file.size,
        owner: owner,
        ownerId: ownerId,
        date: new Date()
    };
    filesDB.insert(fileData, (err, newFile) => {
        res.json({ success: true });
        broadcastUpdate();
    });
});

// Endpoint do pobierania
app.get('/download/:id', (req, res) => {
    filesDB.findOne({ _id: req.params.id }, (err, file) => {
        if (file) res.download(file.path, file.name);
    });
});

let onlineUsers = {}; 

io.on('connection', (socket) => {
    socket.on('auth', async (data) => {
        const { type, username, password } = data;
        usersDB.findOne({ username }, async (err, user) => {
            if (type === 'register') {
                if (user) return socket.emit('auth-error', 'Użytkownik istnieje');
                const hashedPassword = await bcrypt.hash(password, 10);
                usersDB.insert({ username, password: hashedPassword, premium: 'default' }, (err, n) => loginSuccess(n));
            } else {
                if (!user || !(await bcrypt.compare(password, user.password))) return socket.emit('auth-error', 'Błąd logowania');
                loginSuccess(user);
            }
        });
        function loginSuccess(user) {
            onlineUsers[socket.id] = { username: user.username, id: user._id, premium: user.premium };
            socket.emit('auth-success', { username: user.username, id: user._id, premium: user.premium });
            broadcastUpdate();
        }
    });

    socket.on('add-friend', (name) => {
        const me = onlineUsers[socket.id];
        usersDB.findOne({ username: name }, (err, target) => {
            if (target && target.username !== me.username) {
                friendsDB.insert({ user1: me.id, user2: target._id, status: 'accepted' }, () => broadcastUpdate());
            }
        });
    });

    function broadcastUpdate() {
        Object.keys(onlineUsers).forEach(sid => {
            const user = onlineUsers[sid];
            friendsDB.find({ $or: [{ user1: user.id }, { user2: user.id }] }, (err, rels) => {
                const fIds = rels.map(r => r.user1 === user.id ? r.user2 : r.user1);
                // Pobierz pliki znajomych
                filesDB.find({ ownerId: { $in: [...fIds, user.id] } }, (err, files) => {
                    socket.emit('update-data', { files });
                });
            });
        });
    }
    socket.on('disconnect', () => { delete onlineUsers[socket.id]; });
});

server.listen(process.env.PORT || 10000);
