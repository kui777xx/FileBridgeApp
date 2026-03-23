const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Datastore = require('@seald-io/nedb');
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const usersDB = new Datastore({ filename: path.join(__dirname, 'users.db'), autoload: true });
const friendsDB = new Datastore({ filename: path.join(__dirname, 'friends.db'), autoload: true });

app.use(express.static(path.join(__dirname, 'public')));

let onlineUsers = {}; 

io.on('connection', (socket) => {
    
    socket.on('auth', async (data) => {
        const { type, username, password } = data;
        usersDB.findOne({ username }, async (err, user) => {
            if (type === 'register') {
                if (user) return socket.emit('auth-error', 'Użytkownik już istnieje');
                const hashedPassword = await bcrypt.hash(password, 10);
                usersDB.insert({ username, password: hashedPassword, premium: 'default' }, (err, newUser) => {
                    loginSuccess(newUser);
                });
            } else {
                if (!user || !(await bcrypt.compare(password, user.password))) {
                    return socket.emit('auth-error', 'Błędne dane');
                }
                loginSuccess(user);
            }
        });

        function loginSuccess(user) {
            onlineUsers[socket.id] = { username: user.username, id: user._id, premium: user.premium };
            socket.emit('auth-success', { username: user.username, id: user._id, premium: user.premium });
            broadcastUpdate();
        }
    });

    socket.on('redeem-code', (code) => {
        const me = onlineUsers[socket.id];
        let newStatus = code === 'GOLD-COLOR' ? 'gold' : (code === 'RESET' ? 'default' : null);
        if(newStatus && me) {
            usersDB.update({ _id: me.id }, { $set: { premium: newStatus } }, {}, () => {
                onlineUsers[socket.id].premium = newStatus;
                socket.emit('premium-update', newStatus);
                broadcastUpdate();
            });
        }
    });

    socket.on('add-friend', (targetName) => {
        const me = onlineUsers[socket.id];
        usersDB.findOne({ username: targetName }, (err, target) => {
            if (!target || target.username === me.username) return;
            friendsDB.findOne({ $or: [{ user1: me.id, user2: target._id }, { user1: target._id, user2: me.id }] }, (err, exists) => {
                if (!exists) {
                    friendsDB.insert({ user1: me.id, user2: target._id, status: 'pending', sender: me.username }, () => broadcastUpdate());
                }
            });
        });
    });

    socket.on('accept-friend', (name) => {
        const me = onlineUsers[socket.id];
        usersDB.findOne({ username: name }, (err, f) => {
            friendsDB.update({ $or: [{ user1: me.id, user2: f._id }, { user1: f._id, user2: me.id }] }, { $set: { status: 'accepted' } }, {}, () => broadcastUpdate());
        });
    });

    // HANDSHAKE PLIKÓW
    socket.on('file-offer', (data) => {
        const target = Object.keys(onlineUsers).find(id => onlineUsers[id].username === data.to);
        if (target) io.to(target).emit('file-request', { from: onlineUsers[socket.id].username, fileName: data.fileName, fileSize: data.fileSize });
    });

    socket.on('file-accepted', (data) => {
        const target = Object.keys(onlineUsers).find(id => onlineUsers[id].username === data.to);
        if (target) io.to(target).emit('start-webrtc', { from: onlineUsers[socket.id].username });
    });

    socket.on('signal', (data) => {
        const target = Object.keys(onlineUsers).find(id => onlineUsers[id].username === data.to);
        if (target) io.to(target).emit('signal', { signal: data.signal, from: onlineUsers[socket.id].username });
    });

    function broadcastUpdate() {
        Object.keys(onlineUsers).forEach(sid => {
            const uid = onlineUsers[sid].id;
            friendsDB.find({ $or: [{ user1: uid }, { user2: uid }] }, (err, rels) => {
                const fIds = rels.map(r => r.user1 === uid ? r.user2 : r.user1);
                usersDB.find({ _id: { $in: fIds } }, (err, friends) => {
                    const list = friends.map(f => {
                        const r = rels.find(rel => rel.user1 === f._id || rel.user2 === f._id);
                        return { username: f.username, status: r.status, sender: r.sender, isOnline: Object.values(onlineUsers).some(u => u.id === f._id), premium: f.premium };
                    });
                    io.to(sid).emit('friend-list', list);
                });
            });
        });
    }

    socket.on('disconnect', () => { delete onlineUsers[socket.id]; broadcastUpdate(); });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`🚀 Serwer na porcie ${PORT}`));
