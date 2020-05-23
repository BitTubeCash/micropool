# micropool-gui
Minimal Bittube Stratum Server (solopool)

![screenshot](https://cdn.discordapp.com/attachments/713648425849192498/713648446623711232/unknown.png)

To run micropool-gui as a nodejs/electronjs app:

    $ npm install electron -g
    $ git clone https://github.com/tubedev2000/micropool-gui.git
    $ cd micropool-gui
    $ npm install
    $ npm start

To build the micropool as a standalone executable:

    $ npm install electron-builder -g
    $ git clone https://github.com/tubedev2000/micropool-gui.git
    $ cd micropool-gui
    $ npm install
    $ electron-builder --linux
    $ electron-builder --windows
    $ electron-builder --mac
