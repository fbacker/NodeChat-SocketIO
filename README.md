# NodeChat-SocketIO
NodeJS Socket.io chat server with cluster and redis

The chat will run on all CPUs and it's also possible to put it on multiple servers to get better load balancing.

When a user connects he/she can set account id and facebook id. When talking to each other the facebook id is used.



Requirements
------------

    Node
    Npm
    Redis


Installation
------------

    npm install 


Configuration
-------------

Application (app.js)

Edit conf variable with redis port and host. You can also change the chat server port (default 5223)

Load testing (loadtest.js)

Change server variable and ports


Run it
------

Make sure redis is running

Start chat server
node --nouse-idle-notification --expose-gc app.js

Run load testing with 10.000 clients
node loadtest.js 10000