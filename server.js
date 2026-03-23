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
                usersDB.insert({ username, password: hashedPassword, premium: 'default' }, (err, newUser) => loginSuccess(newUser));
            } else {
                if (!user || !(await bcrypt.compare(password, user.password))) return socket.emit('auth-error', 'Błędne dane');
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
        if(!me) return;
        usersDB.findOne({ username: name }, (err, target) => {
            if (!target || target.username === me.username) return;
            friendsDB.findOne({ $or: [{ user1: me.id, user2: target._id }, { user1: target._id, user2: me.id }] }, (err, exists) => {
                if (!exists) friendsDB.insert({ user1: me.id, user2: target._id, status: 'pending', sender: me.username }, () => broadcastUpdate());
            });
        });
    });

    socket.on('accept-friend', (name) => {
        const me = onlineUsers[socket.id];
        if(!me) return;
        usersDB.findOne({ username: name }, (err, f) => {
            if(f) friendsDB.update({ $or: [{ user1: me.id, user2: f._id }, { user1: f._id, user2: me.id }] }, { $set: { status: 'accepted' } }, {}, () => broadcastUpdate());
        });
    });

    socket.on('redeem-code', (code) => {
        const me = onlineUsers[socket.id];
        let status = (code === 'GOLD-COLOR') ? 'gold' : (code === 'RESET' ? 'default' : null);
        if(status && me) usersDB.update({ _id: me.id }, { $set: { premium: status } }, {}, () => {
            onlineUsers[socket.id].premium = status;
            broadcastUpdate();
        });
    });

    socket.on('file-offer', d => {
        const t = Object.keys(onlineUsers).find(id => onlineUsers[id].username === d.to);
        if(t) io.to(t).emit('file-request', { from: onlineUsers[socket.id].username, fileName: d.fileName });
    });

    socket.on('file-accepted', d => {
        const t = Object.keys(onlineUsers).find(id => onlineUsers[id].username === d.to);
        if(t) io.to(t).emit('start-webrtc', { from: onlineUsers[socket.id].username });
    });

    socket.on('signal', d => {
        const t = Object.keys(onlineUsers).find(id => onlineUsers[id].username === d.to);
        if(t) io.to(t).emit('signal', { signal: d.signal, from: onlineUsers[socket.id].username });
    });

    function broadcastUpdate() {
        Object.keys(onlineUsers).forEach(sid => {
            const user = onlineUsers[sid];
            if(!user) return;
            friendsDB.find({ $or: [{ user1: user.id }, { user2: user.id }] }, (err, rels) => {
                const fIds = rels.map(r => r.user1 === user.id ? r.user2 : r.user1);
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

server.listen(process.env.PORT || 10000, () => console.log("Serwer działa"));
