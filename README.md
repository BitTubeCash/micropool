# micropool-gui

Minimal BittubeCash Stratum Server (solopool)

![screenshot](https://media.discordapp.net/attachments/713648425849192498/733050802528321776/unknown.png)

To run micropool-gui as a nodejs/electronjs app:

    $ npm install electron -g
    $ git clone https://github.com/BitTubeCash/micropool-gui.git
    $ cd micropool-gui
    $ npm install
    $ npm start

To build the micropool as a standalone executable:

    $ npm install electron-builder -g
    $ git clone https://github.com/BitTubeCash/micropool-gui.git
    $ cd micropool-gui
    $ npm install
    $ electron-builder --linux
    $ electron-builder --windows
    $ electron-builder --mac
