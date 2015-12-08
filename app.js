
// MUST BE STARTED WITH node --nouse-idle-notification --expose-gc app.js

// logger object
var cluster = require('cluster');
var net = require('net');
var num_processes = require('os').cpus().length;
var conf = {
    port: process.env.PORT || 5223,
    redisPort: 6379,
    redisHost: '127.0.0.1', 
    redisOptions: {},
    redisNamespace: "NodeChat:",
    mainroom: 'MainRoom',
    chatroom: 'ChatRoom',
    //expireTimout: 4 * 60 * 60, // 4 hours, users havn't done anything
    expireCheck: 0.2 * 60 * 1000, // every 20 secondsfor expired things
    expireMessage: 3 * 60, // 30 sec, then remove user
    expireProcess: 3 * 60 // 30 sec, then remove process
    facebookTimeout: 15 * 60 // timeout 15 min
};

var environment = process.env.NODE_ENV;


process.argv.forEach(function (val, index, array) {
    if(val.indexOf("port")>=0){
        var values = val.split("=");
        conf.port = parseInt(values[1]) || conf.port;
    }
    if(val.indexOf("http")>=0){
        var values = val.split("=");
        conf.http = parseBool(values[1]) || conf.http;
    }
});



// logger object
var logger = require('winston');
logger.add(logger.transports.File, { name: 'debug-info',
    filename: 'output-info.log',
    level: 'info,error',
    colorize: true,
    handleExceptions: true });
logger.add(logger.transports.File, { name: 'debug-error',
    filename: 'output-error.log',
    level: 'error',
    colorize: true,
    handleExceptions: true });
logger.info("node environment " + environment);
logger.info("node port. " + conf.port);
// Allow as many connections as possible
var http = require('http');
    http.globalAgent.maxSockets = Infinity;
    http.Agent.maxSockets = Infinity;


if (cluster.isMaster) {

    logger.info("Configuration",conf);

    // This stores our workers. We need to keep them to be able to reference
    // them based on source IP address. It's also useful for auto-restart,
    // for example.
    var workers = [];

    // Helper function for spawning worker at index 'i'.
    var spawn = function(i) {
        workers[i] = cluster.fork();

        // Optional: Restart worker on exit
        workers[i].on('exit', function(worker, code, signal) {
            logger.log('respawning worker', i);
            spawn(i);
        });
    };

    // Spawn workers.
    for (var i = 0; i < num_processes; i++) {
        spawn(i);
    }

    // Create the outside facing server listening on our port.
    var server = net.createServer({ pauseOnConnect: true }, function (connection) {

        // Incoming request processing
        var remote = connection.remoteAddress;
        var local = connection.localAddress;
        var cIp = remote + local;
        var ip = cIp.match(/[0-9]+/g)[0].replace(/,/g, '');
		var wIndex = ip % num_processes;

		var worker = workers[wIndex];

		logger.log("Message to work "+ worker+", remote: "+ remote+ ", local: "+ local+", ip: "+ ip +", index: "+ wIndex);
		worker.send('sticky-session:connection', connection);
        
    });
    server.maxConnections = Infinity;
    server.listen(conf.port);


} else {
    

    logger.info("Load server pid: %d",process.pid);


    /*
     Create two redis connections. A 'pub' for publishing and a 'sub' for subscribing.
     Subscribe 'sub' connection to 'chat' channel.
     */
    var redis = require('redis');
    var db = redis.createClient(conf.redisPort, conf.redisHost, conf.redisOptions);
    var pub = redis.createClient(conf.redisPort, conf.redisHost, conf.redisOptions);
    var sub = redis.createClient(conf.redisPort, conf.redisHost, conf.redisOptions);
    sub.subscribe(conf.redisNamespace+ 'chatmessage'); // someone said something
    sub.subscribe(conf.redisNamespace+ 'chatmessage-confirm'); // someone said something confirm back
    sub.subscribe(conf.redisNamespace+ 'presence-friends'); // loop friend id, if publish exist broadcast online state
    sub.subscribe(conf.redisNamespace+ 'user-clear'); // clear user from memory
    sub.subscribe(conf.redisNamespace+ 'process-start'); // gather process info
    sub.subscribe(conf.redisNamespace+ 'process-end'); // has some data


    // Setup HTTP & Socket Server
    var app = require('express')();
    var http = require('http').Server(app);
    var io = require('socket.io')(http);


    // Feed default webpage if user browse
    app.get('/', function(req, res){
        res.send("It's alive!");
    });
    app.get('/chat', function(req, res){
        res.sendFile(__dirname + '/chat.html');
    });
    app.get('/process', function(req, res){
        res.sendFile(__dirname + '/process.html');
    });
    app.get('/users', function(req, res){
        var socketsInRoom = findClientsSocket(null, [conf.chatroom,conf.mainroom]);
        res.send("Active users: "+ socketsInRoom.length);
    });
    http.listen(0, function(){
        logger.info("HTTP Listening on *:"+conf.port);
    });


    // Listen to messages sent from the master. Ignore everything else.
    process.on('message', function(message, connection) {
        if (message !== 'sticky-session:connection') {
            return;
        }

        // Emulate a connection event on the server by emitting the
        // event with the connection the master sent us.
        http.emit('connection', connection);

        connection.resume();
    });




// sent messages
    var messages = [];
    var processes = [];
    var _ = require('underscore');
    var os = require("os");


    io.on('connection', function(socket){

        logger.log('User Connected. Socket: %s', socket.id);

        // Store user data in db
        var multi = db.multi();
        multi.hset([conf.redisNamespace+ socket.id, 'connectionTime', new Date().getTime()], redis.print);
        multi.hset([conf.redisNamespace+ socket.id, 'socketID', socket.id], redis.print);
        multi.hset([conf.redisNamespace+ socket.id, 'accountID', 'none'], redis.print);
        multi.hset([conf.redisNamespace+ socket.id, 'facebookID', 'none'], redis.print);
        multi.hset([conf.redisNamespace+ socket.id, 'friends', '[]'], redis.print);
        multi.exec();

        // Join basic room
        socket.join(conf.mainroom);


        /**
         * Disconnect user
         */
        socket.on('disconnect', function(){

            try{
                logger.log('User Disconnected. Socket: %s', socket.id);

                db.hget([conf.redisNamespace+ socket.id, 'facebookID'], function(err, facebookid) {

                    if(err!=null){
                        logger.error("User Disconnect Error on Facebook ID: %d, Socket: %s, Error: %j", facebookid, socket.id, err);
                        return;
                    }
                    if(facebookid!=null&&facebookid!="none"){
                        pub.publish(conf.redisNamespace+ "presence-friends", JSON.stringify({
                            id: facebookid,
                            online: false
                        }));
                    }

                    pub.publish(conf.redisNamespace+ "user-clear", JSON.stringify({
                        facebook: facebookid,
                        socket: socket.id
                    }));

                });
            } catch (e){
                logger.error("Socket disconnect crash %s", e);
            }
        });


        /**
         * User set account id
         */
        socket.on('accountid', function(msg){
            try {
                if(msg==null){
                    logger.error("User set Account missing message, Socket: %s", socket.id);
                    return;
                }
                else if(msg.id==null){
                    logger.error("User set Account missing message id, Socket: %s", socket.id);
                    return;
                }

                logger.log("User set Account Id: %s, Socket: %s", msg.id, socket.id);
                multi = db.multi();
                multi.hset([conf.redisNamespace+ socket.id, 'accountID', msg.id], redis.print);
                multi.hset([conf.redisNamespace+ socket.id, 'connectionTime', new Date().getTime()], redis.print);
                multi.exec();
            } catch (e){
                logger.error("Socket accountid crash %s", e);
            }
        });


        /**
         * User set facebook id, needed for chat
         */
        socket.on('facebookid', function(msg){
            try{
                if(msg==null){
                    logger.error("User set Facebook missing message, Socket: %s", socket.id);
                    return;
                }
                else if(msg.id==null){
                    logger.error("User set Facebook missing message id, Socket: %s", socket.id);
                    return;
                }

                logger.log("User set Facebook Id: %s, Socket: %s ", msg.id, socket.id);

                db.hget([conf.redisNamespace+ socket.id, 'facebookID'], function(err, facebookid) {
                    if(err!=null){
                        logger.error("User Get Facebook ID: %s, Socket: %s, Error: %j",facebookid,socket.id,err);
                        return;
                    }

                    db.hget([conf.redisNamespace+ socket.id, 'friends'], function(err, friends_str) {
                        if (err != null) {
                            logger.error("User Get Friends: %s, Socket: %s, Error: %j",friends_str,socket.id,err);
                            return;
                        }

                        // set and broadcast new id
                        multi = db.multi();
                        multi.del(conf.redisNamespace+ facebookid+":socket"); // delete old fb id
                        multi.hset([conf.redisNamespace+ socket.id, 'connectionTime', new Date().getTime()], redis.print);
                        multi.hset([conf.redisNamespace+ socket.id, 'facebookID', msg.id], redis.print);
                        multi.set(conf.redisNamespace+ msg.id+":socket", socket.id, redis.print);
                        multi.expire(conf.redisNamespace+ msg.id+":socket",conf.facebookTimeout);
                        multi.exec();

                        socket.join(conf.chatroom);

                        // say old id is offline
                        if(facebookid!="none"&&facebookid!=msg.id){
                            pub.publish(conf.redisNamespace+ "presence-friends", JSON.stringify({
                                id: facebookid,
                                online: false
                            }));
                        }
                        // new id is online
                        pub.publish(conf.redisNamespace+ "presence-friends", JSON.stringify({
                            id: msg.id,
                            online: true
                        }));

                    });


                });
            } catch (e){
                logger.error("Socket facebookid crash %s", e);
            }
        });

        /**
         * Set friends ids, for presence events
         */
        socket.on('friends', function(msg) {
            try{
                if(msg==null){
                    logger.error("User set Friends missing message, Socket: %s", socket.id);
                    return;
                }
                else if(msg.friends==null){
                    logger.error("User set Friends missing message id, Socket: %s", socket.id);
                    return;
                }


                logger.log("User set friends %j, Socket: %s", msg.friends, socket.id);

                db.hget([conf.redisNamespace+ socket.id, 'friends'], function(err, friends_str) {
                    if(err!=null){
                        logger.error("User Get Friends: %s, Socket: %s, Error: %j",friends_str,socket.id,err);
                        return;
                    }
                    var friends = JSON.parse(friends_str);
                    if( friends instanceof Array && msg.friends instanceof Array ) {
                        // add new friends
                        for (var i = 0; i < msg.friends.length; i++) {
                            // get unique friends
                            var fbid = msg.friends[i];
                            if (friends.indexOf(fbid) === -1) {
                                friends.push(fbid);
                            }
                        }

                        // save friends
                        multi = db.multi();
                        multi.hset([conf.redisNamespace+ socket.id, 'connectionTime', new Date().getTime()], redis.print);
                        multi.hset([conf.redisNamespace+ socket.id, 'friends', JSON.stringify(friends)], redis.print);
                        multi.exec();

                        // do in loop because of scoping issue
                        for (var j = 0; j < friends.length; j++) {
                            friendCheckOnline(friends[j]);
                        }
                    }
                    else{
                        // something is not right
                        logger.error("User set Friends an array is wrong, Socket: %s, input: %s, redis: %s", socket.id,msg.friends, friends_str);
                    }
                });
            } catch (e){
                logger.error("Socket friends crash %s", e);
            }
        });
        // Check if a friend is currently online, send to active socket
        var friendCheckOnline = function(friendId){
            try{
                if(friendId==null||friendId==""||friendId=="none"){
                    logger.error("Check friend online with missing id, Socket: %s",socket.id);
                    return;
                }
                db.get(conf.redisNamespace+ friendId+":socket", function (err, localsocket) {
                    if (err != null) {
                        logger.error("Missing friend socket: %s, Socket: %s, Error: %j",localsocket.id,socket.id,err);
                        return;
                    }
                    if(localsocket!=null&&localsocket.length>0){
                        socket.emit('presence', {
                            facebook:friendId,
                            online: true
                        });
                    }
                });
            } catch (e){
                logger.error("Socket friend-check-online crash %s", e);
            }
        };

        /**
         * Someone say something to someone else
         */
        socket.on('message', function(msg){
            try{
                // must have fb id
                if(msg === null) {
                    logger.error("Talk with missing input. Socket: %s",socket.id);
                    return;
                }else if( msg.to === "" || msg.message === "") {
                    logger.error("Talk with missing values. Socket: %s, To: %s, Message: %s",socket.id,msg.to,msg.message);
                    return;
                }

                var to = msg.to;
                var message = msg.message;
                db.hget([conf.redisNamespace+ socket.id,"facebookID"], function(err, id) {
                    if(id==null||id==""||id=="none"){
                        logger.error("On Message: Talk with missing Facebook Id: %s, Socket: %s, Error: %j",id,socket.id,err);
                        return;
                    }

                    msg.from = id;
                    msg.socket = socket.id;

                    db.hset([conf.redisNamespace+ socket.id, 'connectionTime', new Date().getTime()], redis.print);

                    // find friend
                    logger.info("Send Message. %j, Socket: %s",msg,socket.id);

                    db.get(conf.redisNamespace+ msg.to+":socket", function(err, socketFriendID) {

                        if(err!=null){
                            logger.error("Send error, missing socket: %d, Socket: %s, Error: %j",msg,socketFriendID,err);
                            return;
                        }
                        if(socketFriendID && socketFriendID.length> 0 ){
                            msg.socketto = socketFriendID;
                            msg.time = new Date().getTime();
                            messages.push(msg);
                            pub.publish(conf.redisNamespace+ "chatmessage",JSON.stringify(msg));
                        }else{
                            socket.emit('presence', {
                                facebook:msg.to,
                                online: false
                            });
                        }

                    });
                });
            } catch (e){
                logger.error("Socket message crash %s", e);
            }
        });


        socket.on('messagetoall', function(msg){
            try{
                if(msg==null||msg==""){
                    logger.error("Talk to all with missing input. Socket: %s",socket.id);
                    return;
                }
                db.hset([conf.redisNamespace+ socket.id, 'connectionTime', new Date().getTime()], redis.print);
                var o = {
                    to:"broadcastservice",
                    from:"broadcastservice",
                    message:msg};
                pub.publish(conf.redisNamespace+ "chatmessage",JSON.stringify(o));
            } catch (e){
                logger.error("Socket messagetoall crash %s", e);
            }
        });


		// Client start process call to all nodes
        socket.on('process', function(){
            try{
                var o = {
                    socket: socket.id
                };
                pub.publish(conf.redisNamespace+ "process-start",JSON.stringify(o));
            } catch (e){
                logger.error("Socket process crash %s", e);
            }
        });

		// Client grab all process information
        socket.on('process-get', function(){
            try{
                for(var i = 0; i < processes.length; i++){
                    var process = processes[i];
                    if(process.socket==socket.id){
                        // we requested the data
                        socket.emit('presence-data', process);
                    }
                }
                processes = [];
            } catch (e){
                logger.error("Socket process-get crash %s", e);
            }
        });



    });




    /*
     Use Redis' 'sub' (subscriber) client to listen to any message from Redis to server.
     When a message arrives, send it back to browser using socket.io
     */
    sub.on('message', function(channel, message) {

        logger.log("Redis Message. Channel %s, Message: %s",channel,message);

        switch(channel) {

        /**
         * A user or broadcast service is talking to someone else
         */
            case conf.redisNamespace + "chatmessage" :

                try {
                    var msg = JSON.parse(message);
                    if (msg.to == msg.from && msg.from == "broadcastservice") {
                        // Send to all
                        io.emit('message', msg);
                        return;
                    }


                    var socketsInRoom = findClientsSocket(null, [conf.chatroom]);
                    for (var i = 0; i < socketsInRoom.length; i++) {
                        if (socketsInRoom[i].id == msg.socketto) {
                            socketsInRoom[i].emit("message", msg);
                            pub.publish(conf.redisNamespace + "chatmessage-confirm", JSON.stringify(msg));
                            break;
                        }
                    }
                } catch (e){
                    logger.error("Message chatmessage crash %s", e);
                }
                break;

		/**
		*	We get back that the msssage was successfully delivered
		*/
            case conf.redisNamespace+ "chatmessage-confirm" :
                try{
                    var msg = JSON.parse(message);
                    var socketsInRoom = findClientsSocket(null, [conf.mainroom,conf.chatroom]);
                    for (var i = 0; i < socketsInRoom.length; i++) {
                        var localsocket = socketsInRoom[i];
                        if(localsocket.id==msg.socket){
                            var index = -1;
                            _.find(messages, function(obj, Idx){
                                if(obj.socket == msg.socket && obj.message == msg.message && obj.socketto == msg.socketto && obj.time == msg.time){ index = Idx; return true;};
                            });
                            if(index!=-1){
                                messages.splice(index,1);
                            }
                            break;
                        }
                    }
                } catch (e){
                    logger.error("Message chatmessage-confirm crash %s", e);
                }
                break;

        /**
         * Loop all chat users, if a friend is a match, tell them the id state
         */
            case conf.redisNamespace + "presence-friends" :
                try{
                    /*
                     msg.id
                     msg.online
                     */
                    var msg = JSON.parse(message);
                    var socketsInRoom = findClientsSocket(null, [conf.chatroom]);
                    for (var i = 0; i < socketsInRoom.length; i++) {
                        var localsocket = socketsInRoom[i];
                        db.hget([conf.redisNamespace + localsocket.id, "friends"], function (err, friends_str) {

                            if (err != null) {
                                logger.error("Get friends local socket error, socket: %s, Error: %j", localsocket.id, err);
                                return;
                            }
                            if (friends_str != null) {
                                var friends = JSON.parse(friends_str);
                                for (var j = 0; j < friends.length; j++) {
                                    if (friends[j] == msg.id) {
                                        // We have a match. Tell them publichers status
                                        localsocket.emit('presence', {
                                            facebook: msg.id,
                                            online: msg.online
                                        });
                                    }
                                }
                            }
                        });
                    }
                } catch (e){
                    logger.error("Message precense-friends crash %s", e);
                }
                break;


        /**
         * Remove user from server
         */
            case conf.redisNamespace + "user-clear" :
                try{
                    /*
                     msg.socket
                     msg.facebook
                     */
                    var msg = JSON.parse(message);
                    clearConnection(msg.socket, msg.facebook);
                } catch (e){
                    logger.error("Message user-clear crash %s", e);
                }
                break;


        /**
         * Process information for display
         */
            case conf.redisNamespace + "process-start" :
                try{
                    var msg = JSON.parse(message);
                    var mem = process.memoryUsage();
                    var socketsInRoom = findClientsSocket(null, [conf.mainroom,conf.chatroom]);
                    var o = {
                        socket: msg.socket,
                        clients: socketsInRoom.length,
                        server: os.hostname(),
                        cpus: os.cpus().length,
                        pid: process.pid,
                        platform: process.platform,
                        arch: process.arch,
                        uptime: process.uptime(),
                        rss: mem.rss,
                        heaptotal: mem.heapTotal,
                        heapused: mem.heapUsed,
                        created: new Date().getTime()
                    };
                    pub.publish(conf.redisNamespace+ "process-end",JSON.stringify(o));
                } catch (e){
                    logger.error("Message process-start crash %s", e);
                }
                break;


            case conf.redisNamespace + "process-end" :
                try{
                    var msg = JSON.parse(message);
                    processes.push(msg);
                } catch (e){
                    logger.error("Message process-end crash %s", e);
                }
                break;
        }

    });

	/**
	* Find sockets in namespace and room
	*/
    function findClientsSocket(namespace, roomIds) {
        try {
            var res = []
                , ns = io.of(namespace || "/");    // the default namespace is "/"

            if (ns) {
                for (var id in ns.connected) {
                    if (roomIds.length > 0) {
                        for (var roomIdIndex in roomIds) {
                            var roomId = roomIds[roomIdIndex];
                            var index = ns.connected[id].rooms.indexOf(roomId);
                            if (index !== -1) {
                                res.push(ns.connected[id]);
                                break; // found in room, break so not check doublettes
                            }
                        }
                    } else {
                        res.push(ns.connected[id]);
                    }
                }
            }
            return res;
        } catch (e){
            logger.error("findClientSocket crash %s", e);
            return [];
        }
    }


	/**
	* Clear socket connection from Redis and chat node
	*/
    function clearConnection(socketid, facebookid){
        try{
            if( (socketid == null || socketid == "") && (facebookid == null || facebookid == "")){
                logger.error("Clear connections missing . Socket: %s",socket.id);
                return;
            }
            // clear redis
            multi = db.multi();
            if(socketid != null && socketid != ""){
                multi.hdel(conf.redisNamespace+ socketid, "connectionTime");
                multi.hdel(conf.redisNamespace+ socketid, "socketID");
                multi.hdel(conf.redisNamespace+ socketid, "accountID");
                multi.hdel(conf.redisNamespace+ socketid, "facebookID");
                multi.hdel(conf.redisNamespace+ socketid, "friends");
            }
            if(facebookid != null && facebookid != "") {
                multi.del(conf.redisNamespace + facebookid + ":socket");
            }
            multi.exec();

            // Make sure connection is closed
            var socketsInRoom = findClientsSocket(null, [conf.chatroom,conf.mainroom]);
            for(var i = 0; i < socketsInRoom.length; i++) {
                var localsocket = socketsInRoom[i];
                if(localsocket.id==socketid){
                    localsocket.disconnect();
                    break;
                }
            }
        } catch (e){
            logger.error("Clear connection crash %s", e);
        }
    }


    var runState = 0;
    function clearDeadConnections(){
        runState++;
        if(runState>2) { runState = 0 };

        logger.log("Check for dead connecions, Run normal: %d",runState);

        switch(runState){

            // Check message timeout
            case 0 :
                logger.log("Message check: %d",messages.length);
                for(var i = messages.length-1; i >= 0; i--){
                    var message = messages[i];
                    var currentTime = new Date();
                    var lastTime = new Date(parseInt(message.time));
                    var seconds = (currentTime.getTime() - lastTime.getTime()) / 1000;
                    if(seconds>conf.expireMessage){
                        logger.error("Message timeout %d, obj #j",seconds, message);
                        messages.splice(i,1);
                        pub.publish(conf.redisNamespace+ "presence-friends", JSON.stringify({
                            id: message.to,
                            online: false
                        }));
                        pub.publish(conf.redisNamespace+ "user-clear", JSON.stringify({
                            facebook: message.to,
                            socket: message.socketto
                        }));
                    }
                }
                break;

            // clear old process calls
            case 1 :
                for(var i = processes.length-1; i >= 0; i--){
                    var process = processes[i];
                    var currentTime = new Date();
                    var lastTime = new Date(parseInt(process.time));
                    var seconds = (currentTime.getTime() - lastTime.getTime()) / 1000;
                    if(seconds>conf.expireProcess) {
                        logger.error("Process timeout %d, obj #j", seconds, message);
                        processes.splice(i,1);
                    }
                }
                break;
                
            // Garbage collector
            case 2 :
	            logger.log("Clear Garbage Collector");
            	global.gc();
            	break;
        }

    }
    setInterval(clearDeadConnections, conf.expireCheck);


    logger.info("Server is up and running");
}
