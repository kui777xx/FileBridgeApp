const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Datastore = require('@seald-io/nedb');
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Ustawienie ścieżek do bazy danych w folderze projektu
const usersDB = new Datastore({ 
    filename: path.join(__dirname, 'users.db'), 
    autoload: true 
});
const friendsDB = new Datastore({ 
    filename: path.join(__dirname, 'friends.db'), 
    autoload: true 
});

// Serwowanie plików statycznych z folderu public
app.use(express.static(path.join(__dirname, 'public')));

let onlineUsers = {}; // socket.id -> {username, userId}

io.on('connection', (socket) => {
    console.log('Nowe połączenie socketu:', socket.id);

    // --- LOGOWANIE I REJESTRACJA ---
    socket.on('auth', async (data) => {
        const { type, username, password } = data;
        
        if (!username || !password) {
            return socket.emit('auth-error', 'Wypełnij wszystkie pola!');
        }

        usersDB.findOne({ username: username }, async (err, user) => {
            if (err) return socket.emit('auth-error', 'Błąd bazy danych');

            if (type === 'register') {
                if (user) return socket.emit('auth-error', 'Użytkownik już istnieje');
                
                try {
                    const hashedPassword = await bcrypt.hash(password, 10);
                    const newUserDoc = { username: username, password: hashedPassword };
                    
                    usersDB.insert(newUserDoc, (err, insertedDoc) => {
                        if (err) {
                            console.error("❌ BŁĄD ZAPISU W BAZIE:", err);
                            return socket.emit('auth-error', 'Błąd zapisu na dysku. Sprawdź uprawnienia folderu.');
                        }
                        console.log(`✨ Nowe konto stworzone: ${username}`);
                        loginSuccess(insertedDoc);
                    });
                } catch (e) {
                    socket.emit('auth-error', 'Błąd podczas szyfrowania hasła');
                }
            } else {
                // Logika logowania
                if (!user) return socket.emit('auth-error', 'Użytkownik nie istnieje');
                
                const isMatch = await bcrypt.compare(password, user.password);
                if (!isMatch) return socket.emit('auth-error', 'Błędne hasło');
                
                loginSuccess(user);
            }
        });

        function loginSuccess(user) {
            onlineUsers[socket.id] = { username: user.username, id: user._id };
            socket.emit('auth-success', { username: user.username, id: user._id });
            console.log(`✅ Zalogowano użytkownika: ${user.username}`);
            broadcastUpdate();
        }
    });

    // --- SYSTEM ZNAJOMYCH ---
    socket.on('add-friend', (targetName) => {
        const me = onlineUsers[socket.id];
        if(!me) return;

        usersDB.findOne({ username: targetName }, (err, targetUser) => {
            if (err || !targetUser || targetUser.username === me.username) return;
            
            friendsDB.update(
                { $or: [{ user1: me.id, user2: targetUser._id }, { user1: targetUser._id, user2: me.id }] },
                { user1: me.id, user2: targetUser._id, status: 'accepted' },
                { upsert: true },
                () => {
                    console.log(`🤝 ${me.username} i ${targetName} zostali znajomymi`);
                    broadcastUpdate();
                }
            );
        });
    });

    // --- PRZESYŁANIE SYGNAŁÓW (WebRTC) ---
    socket.on('signal', (data) => {
        const targetSocket = Object.keys(onlineUsers).find(id => onlineUsers[id].username === data.to);
        if (targetSocket) {
            io.to(targetSocket).emit('signal', { 
                signal: data.signal, 
                from: onlineUsers[socket.id].username 
            });
        }
    });

    // Aktualizacja listy znajomych dla wszystkich online
function broadcastUpdate() {
    console.log("📢 Rozpoczynam aktualizację list znajomych dla wszystkich online...");
    
    Object.keys(onlineUsers).forEach(socketId => {
        const currentUser = onlineUsers[socketId];
        const userId = currentUser.id;

        // Szukamy wszystkich relacji (zaakceptowanych i oczekujących)
        friendsDB.find({ $or: [{ user1: userId }, { user2: userId }] }, (err, relations) => {
            if (err) return console.error("Błąd bazy friends:", err);

            const friendIds = relations.map(r => r.user1 === userId ? r.user2 : r.user1);
            
            usersDB.find({ _id: { $in: friendIds } }, (err, friends) => {
                const list = friends.map(f => {
                    const rel = relations.find(r => r.user1 === f._id || r.user2 === f._id);
                    // Sprawdzamy czy znajomy jest teraz online
                    const friendOnline = Object.values(onlineUsers).some(u => u.id === f._id);
                    
                    return {
                        username: f.username,
                        status: rel.status,
                        sender: rel.sender,
                        isOnline: friendOnline,
                        premium: f.premium || 'default'
                    };
                });

                console.log(`📤 Wysyłam listę (${list.length} znajomych) do: ${currentUser.username}`);
                io.to(socketId).emit('friend-list', list);
            });
        });
    });
}

    socket.on('disconnect', () => {
        if(onlineUsers[socket.id]) {
            console.log(`🚶 Wylogowano: ${onlineUsers[socket.id].username}`);
            delete onlineUsers[socket.id];
            broadcastUpdate();
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\n🚀 RAKIETA WYSTARTOWAŁA!`);
    console.log(`👉 Adres: http://localhost:${PORT}`);
    console.log(`📂 Folder projektu: ${__dirname}\n`);
});
