console.log("LoadTest Chat");


// node loadtest.js clients prefix sendprefix
// node loadtest.js 1000 fb1 fb2

var http = require('http');
    http.globalAgent.maxSockets = Infinity;
    http.Agent.maxSockets = Infinity;

// Interpreted from the command line; more on this below
var clientCount = 1;
var clientPrefix = "fb";
var friendPrefix = "fb";
process.argv.forEach(function (val, index, array) {
    if(index==2){
        clientCount = parseInt(val);
    } else if(index==3){
        clientPrefix = val;
    }
    else if(index==4){
        friendPrefix = val;
    }
});
console.log("  Number of clients "+ clientCount);
if(clientCount==1) {
    console.log("     Set number of clients by adding int after script");
    console.log("     Example: node loadtest.js clients client, prefix, friend prefix");
    console.log("     Example: node loadtest.js 44 fb1 fb2");
}

var randomIntFromInterval = function (min,max)
{
    return Math.floor(Math.random()*(max-min+1)+min);
};

var heartbeatInterval = 50;//clientCount * (50 + randomIntFromInterval(0,50));//25 * 1000;
var idx = 0;
var intervalID;
var stats = [];
var ports = [5223];
var server = "ws://localhost";

var saySomething = function(socket){
    var touser = friendPrefix+((socket.localid) ? 0 : (socket.localid-1));
    console.log("Say to user "+touser +", from: "+ socket.localid);
    socket.emit("message",{to:touser,message:"a message here"});

    socket.localcounter++;

    if(socket.localcounter > 10){
        console.log("Shutdown socket "+ socket.localid);
        clearInterval(socket.socketInterval);
        socket.disconnect();
    }

};
var makeConnection = function() {
    var port = ports[idx%ports.length];
    var uri = server+':'+port;
    var socket = require("socket.io-client")(uri, { forceNew: true, reconnection: true , multiplex:false, transports:['websocket'] });
    // ,
    socket.localid = idx;
    socket.localcounter = 0;
    console.log("Make Connection to : "+ uri);
    console.log("Create socket. "+ socket.localid);

    socket.on('connect', function(){
       console.log("connected "+ socket.localid);
        socket.emit('accountid', {"id":"acc"+socket.localid});
        socket.emit('facebookid', {"id":clientPrefix+socket.localid});
        console.log("Set user. "+ "acc"+socket.localid + ", fb: "+ clientPrefix+socket.localid);
        //socket.socketInterval = setInterval(saySomething,20000+randomIntFromInterval(0,666),socket);
    });
    socket.on('disconnect', function(){
        console.log("disconnect "+ socket.localid);
        //socket.reconnect();
    });

    socket.on("message", function(msg) {
        stats.push([socket.id, new Date().getTime()]);
    });

    socket.on('error', function(error){
        console.log("error "+ error);
    });
    socket.on('connect_error', function(error){
        console.log("conn error "+ error);
    });

    idx++;
    if (idx === clientCount) {
        console.log("Do not create anymore sockets "+idx);
        clearInterval(intervalID);
    }

};

console.log("Load with interval "+heartbeatInterval);
intervalID = setInterval(makeConnection, heartbeatInterval);
