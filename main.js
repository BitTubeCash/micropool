// Modules to control application life and create native browser window
const {app, BrowserWindow, ipcMain} = require('electron')
const storage = require('electron-json-storage');
const contextMenu = require('electron-context-menu');
const path = require('path');
var os = require('os');
var ifaces = os.networkInterfaces();

var c29b = require('./c29b_nowasm.js');
var verify_c29b = c29b.cwrap('c29b_verify', 'number', ['array','number','array']);
var check_diff = c29b.cwrap('check_diff', 'number', ['number','array']);

var emb_miner_status = 0;
var emb_daemon_status = 0;

global.poolconfig = { 
	poolport:25650, 
	ctrlport:25651,// use with https://github.com/swap-dev/on-block-notify.git
	daemonport:25182,
	daemonhost:'127.0.0.1',
	mining_address:'',
	emb_miner:false,
	emb_daemon:true
};

const http = require('http');
const https = require('https');
const net = require("net");


function seq(){
	var min = 1000000000;
	var max = 2000000000;
	var id = Math.floor(Math.random() * (max - min + 1)) + min;
	return id.toString();
};

function isDev() {
	return process.mainModule.filename.indexOf('app.asar') === -1;
}

function Log() {}
Log.prototype.log = function (level,message) {if(mainWindow)mainWindow.webContents.send('log', [level,message]);}
Log.prototype.info  = function (message) {this.log('info',message);}
Log.prototype.error = function (message) {this.log('error',message);}
Log.prototype.debug = function (message) {this.log('debug',message);}
const logger = new Log();

process.on("uncaughtException", function(error) {
	logger.error(error);
});

function jsonHttpRequest(host, port, data, callback, path){
	path = path || '/json_rpc';

	var options = {
		hostname: host,
		port: port,
		path: path,
		method: data ? 'POST' : 'GET',
		headers: {
			'Content-Length': data.length,
			'Content-Type': 'application/json',
			'Accept': 'application/json'
		}
	};

	var req = (port == 443 ? https : http).request(options, function(res){
		var replyData = '';
		res.setEncoding('utf8');
		res.on('data', function(chunk){
			replyData += chunk;
		});
		res.on('end', function(){
			var replyJson;
			try{
				replyJson = JSON.parse(replyData);
			}
			catch(e){
				callback(e);
				return;
			}
			callback(null, replyJson);
		});
	});

	req.on('error', function(e){
		callback(e);
	});

	req.end(data);
}

function rpc(method, params, callback){

	var data = JSON.stringify({
		id: "0",
		jsonrpc: "2.0",
		method: method,
		params: params
	});
	jsonHttpRequest(global.poolconfig.daemonhost, global.poolconfig.daemonport, data, function(error, replyJson){
		if (error){
			callback(error);
			return;
		}
		callback(replyJson.error, replyJson.result)
	});
}

function getBlockTemplate(callback){
	rpc('getblocktemplate', {reserve_size: 0, wallet_address: global.poolconfig.mining_address}, callback);
}

var current_target    = 0;
var current_height    = 1;
var current_reward    = 0;
var current_blob      = "";
var current_hashblob  = "";
var previous_hashblob = "";
var current_prevhash  = "";
var connectedMiners   = {};
var jobcounter        = 0;
var blockstxt         = "";
var jobshares         = 0;
var totalEffort       = 0;
var shares=0;
var blocks=0;
var blocks_unlocked=0;
var blocks_orphaned=0;
var unlocked_coins=0;
var conn=0;
var locked_blocks = [];

function resetData() {
	shares=0;
	blocks=0;
	jobshares=0;
	totalEffort=0;
	blocks_unlocked=0;
	blocks_orphaned=0;
	unlocked_coins=0;
	locked_blocks=[];
	mainWindow.webContents.send('get-reply', ['data_shares', 0]);
	mainWindow.webContents.send('get-reply', ['data_blocks', 0]);
	mainWindow.webContents.send('get-reply', ['data_currenteffort', "0.00%"]);
	mainWindow.webContents.send('get-reply', ['data_averageeffort', "0.00%"]);
}

function check_block(block) {

	rpc('getblock', {height: block[1]}, function(error,result){

		if(block[0] == result.block_header.hash){
			blocks_unlocked++;
			unlocked_coins+=result.block_header.reward;
		}
		else{
			blocks_orphaned++;
		}
		mainWindow.webContents.send('get-reply', ['data_blocks_unlocked',blocks_unlocked]);
		mainWindow.webContents.send('get-reply', ['data_blocks_orphaned',blocks_orphaned]);
		mainWindow.webContents.send('get-reply', ['data_total_earned',((unlocked_coins/1000000000).toFixed(2))+' TUBE']);
	
	});
}

function unlocker(){

	var blocks=[];

	for(var block of locked_blocks){

		if(block[1]+60 < current_height)
		{
			check_block(block);
		}
		else
		{
			blocks.unshift(block);
		}
	}

	locked_blocks=blocks;


}

setInterval(unlocker, 5000);

function updateWallet() {
	mainWindow.webContents.send('set', 'mining_address', global.poolconfig.mining_address);
}


function nonceCheck(miner,nonce) {

	if (miner.nonces.indexOf(nonce) !== -1) return false;

	miner.nonces.push(nonce);

	return true;
}

function hashrate(miner) {

	miner.shares += miner.difficulty|0;

	var hr = miner.shares*40/((Date.now()/1000|0)-miner.begin);

	miner.gps = hr;
	
	var total = 0;
	var workertxt='';

	for (var minerId in connectedMiners){
		var miner2 = connectedMiners[minerId];
		total+=miner2.gps;
		workertxt+=miner2.login+' '+miner2.agent+' '+miner2.pass+' '+miner2.difficulty+' '+miner2.shares+' '+miner2.gps.toFixed(2)+'<br/>';
	}
	mainWindow.webContents.send('workers', workertxt);
	mainWindow.webContents.send('get-reply', ['data_gps',total.toFixed(2)+" Gps"]);

	return 'rig:'+miner.pass+' '+hr.toFixed(2)+' gps';
		
}

function updateJob(reason,callback){

	getBlockTemplate(function(error, result){
		if(error) {
			logger.error(error.message);
			return;
		}

		var previous_hash_buf = Buffer.alloc(32);
		Buffer.from(result.blocktemplate_blob, 'hex').copy(previous_hash_buf,0,7,39);
		var previous_hash = previous_hash_buf.toString('hex');
		

		if(previous_hash != current_prevhash){

			previous_hashblob = current_hashblob;
			
			current_prevhash = previous_hash;
			current_target   = result.difficulty;
			current_blob     = result.blocktemplate_blob;
			current_hashblob = result.blockhashing_blob.slice(0,-16);	
			current_height   = result.height;
			current_reward   = result.expected_reward / Math.pow (10,9);
			
			jobcounter++;

			logger.info('New block to mine at height '+result.height+' w/ difficulty of '+result.difficulty+' (triggered by: '+reason+')');

			mainWindow.webContents.send('get-reply', ['data_diff',result.difficulty]);
			mainWindow.webContents.send('get-reply', ['data_height',result.height]);
			mainWindow.webContents.send('get-reply', ['data_netgraphrate', (current_target / 15000 * 40).toFixed(2) + ' KGps' ]);
			mainWindow.webContents.send('get-reply', ['data_reward',current_reward.toFixed(2) + ' TUBE']);
		
			for (var minerId in connectedMiners){
				var miner = connectedMiners[minerId];
				miner.nonces = [];
				var response2 = '{"id":"Stratum","jsonrpc":"2.0","method":"getjobtemplate","result":{"algo":"cuckaroo","edgebits":29,"proofsize":40,"noncebytes":4,"difficulty":'+miner.difficulty+',"height":'+current_height+',"job_id":'+seq()+',"pre_pow":"'+current_hashblob+miner.nextnonce()+'"},"error":null}';
				miner.socket.write(response2+"\n");
			}
		}
		if(callback) callback();
	});
}

function Miner(id,socket){
	this.socket = socket;
	this.login = '';
	this.pass = '';
	this.agent = '';
	this.jobnonce = '';
	this.oldnonce = '';
	this.begin = Date.now()/1000|0;
	this.shares = 0;
	this.gps = 0;
	this.difficulty = 1;
	this.id = id;
	this.nonces = [];
	
	var client = this;
	
	socket.on('data', function(input) {
		try{
			for (var data of input.toString().trim().split("\n"))
				handleClient(data,client);
		}
		catch(e){
			logger.error("error: "+e+" on data: "+input);
			socket.end();
		}
	});
	
	socket.on('close', function(had_error) {
		logger.info('miner connction dropped '+client.login);
		mainWindow.webContents.send('get-reply', ['data_conn',--conn]);
		delete connectedMiners[client.id];
		var total=0;
		var workertxt='';
		for (var minerId in connectedMiners){
			var miner2 = connectedMiners[minerId];
			total+=miner2.gps;
			workertxt+=miner2.login+' '+miner2.agent+' '+miner2.pass+' '+miner2.difficulty+' '+miner2.shares+' '+miner2.gps.toFixed(2)+'<br/>';
		}
		mainWindow.webContents.send('workers', workertxt);
		mainWindow.webContents.send('get-reply', ['data_gps',total.toFixed(2)+" Gps"]);
		socket.end();
	});

	socket.on('error', function(had_error) {
		socket.end();
	});
}
Miner.prototype.respose = function (result,error,request) {
	
	var response = JSON.stringify({
			id:request.id.toString(),
			jsonrpc:"2.0",
			method:request.method,
			result: (result?result:null),
			error: (error?error:null)
	});
	logger.debug("p->m "+response);
	this.socket.write(response+"\n");
}

Miner.prototype.nextnonce = function () {

	this.oldnonce = this.jobnonce;
	
	var noncebuffer = Buffer.allocUnsafe(4);
	noncebuffer.writeUInt32BE(++jobcounter,0);
	this.jobnonce = noncebuffer.reverse().toString('hex')+'00000000';
	
	return this.jobnonce;
}


function handleClient(data,miner){
	
	logger.debug("m->p "+data);

	var request = JSON.parse(data.replace(/([0-9]{15,30})/g, '"$1"'));//puts all long numbers in quotes, js can't handle 64bit ints

	var response;

	if(request && request.method && request.method == "login") {

		miner.login=request.params.login;
		miner.pass =request.params.pass;
		miner.agent =request.params.agent;
		var fixedDiff = miner.login.indexOf('.');
		if(fixedDiff != -1) {
			miner.difficulty = miner.login.substr(fixedDiff + 1);
			if(miner.difficulty < 1) miner.difficulty = 1;
			if(isNaN(miner.difficulty)) miner.difficulty = 1;
			miner.login = miner.login.substr(0, fixedDiff);
		}
		logger.info('miner connect '+request.params.login+' ('+request.params.agent+') ('+miner.difficulty+')');
		
		var workertxt='';
		for (var minerId in connectedMiners){
			var miner2 = connectedMiners[minerId];
			workertxt+=miner2.login+' '+miner2.agent+' '+miner2.pass+' '+miner2.difficulty+' '+miner2.shares+' '+miner2.gps.toFixed(2)+'<br/>';
		}
		mainWindow.webContents.send('workers', workertxt);
		return miner.respose('ok',null,request);
	}
	
	if(request && request.method && request.method == "submit") {

		if(!request.params || !request.params.pow || !request.params.nonce || request.params.pow.length != 40) {

			logger.info('bad data ('+miner.login+')');
			return miner.respose(null,{code: -32502, message: "wrong hash"},request);
		}
		
		if(! nonceCheck(miner,request.params.pow.join('.'))) {
		
			logger.info('duplicate ('+miner.login+')');
			return miner.respose(null,{code: -32503, message: "duplicate"},request);
		}
		
		var cycle = Buffer.allocUnsafe(request.params.pow.length*4);
		for(var i in request.params.pow)
		{
			cycle.writeUInt32LE(request.params.pow[i], i*4);
		}
		var noncebuffer = Buffer.allocUnsafe(4);
		noncebuffer.writeUInt32BE(request.params.nonce,0);
		var header = Buffer.concat([Buffer.from(current_hashblob, 'hex'),Buffer.from(miner.jobnonce,'hex'),noncebuffer]);
			
		if(verify_c29b(header,header.length,cycle)){

			var header_previous = Buffer.concat([Buffer.from(previous_hashblob, 'hex'),Buffer.from(miner.oldnonce,'hex'),noncebuffer]);
			
			if(verify_c29b(header_previous,header_previous.length,cycle)){
			
				logger.info('wrong hash or very old ('+miner.login+') '+request.params.height);
				return miner.respose(null,{code: -32502, message: "wrong hash"},request);
			}
			else{

				logger.info('stale ('+miner.login+')');
				return miner.respose('stale',null,request);
			}
		}
		
		if(check_diff(current_target,cycle)) {
			
			var block = Buffer.from(current_blob, 'hex');

			for(var i in request.params.pow)
			{
				block.writeUInt32LE(request.params.pow[i], 51+(i*4));
			}
			block.writeUInt32LE(request.params.nonce,47);
			Buffer.from(miner.jobnonce, 'hex').copy(block,39,0,8);

			var block_found_height = current_height;

			rpc('submitblock', [block.toString('hex')], function(error, result){
				logger.info('BLOCK ('+miner.login+')');
				if(result){
					locked_blocks.unshift([result.hash,block_found_height,(jobshares/current_target*100).toFixed(2)+'%']);
					updateJob('found block');
					blocks++;
					mainWindow.webContents.send('get-reply', ['data_blocks',blocks]);
					blockstxt+=block_found_height+' '+((jobshares/current_target*100).toFixed(2))+'%<br/>';
					totalEffort+=jobshares/current_target;
					jobshares=0;
					mainWindow.webContents.send('blocks', blockstxt);
					mainWindow.webContents.send('get-reply', ['data_averageeffort',(totalEffort/blocks*100).toFixed(2)+'%']);
				}
			});
		}
		
		if(check_diff(miner.difficulty,cycle)) {
		
			shares+=parseFloat(miner.difficulty);
			jobshares+=parseFloat(miner.difficulty);
			mainWindow.webContents.send('get-reply', ['data_shares',shares]);
			mainWindow.webContents.send('get-reply', ['data_currenteffort',(jobshares/current_target*100).toFixed(2)+'%']);
			
			var totalgps=0;
			for (var minerId in connectedMiners){
				var miner2 = connectedMiners[minerId];
				totalgps+=miner2.gps;
			}
			var etaTime = new Date(0);
			if (totalgps)
			{
				etaTime.setSeconds(parseInt(current_target/totalgps * 40));
			}
			else
			{
				etaTime.setSeconds(0)
			}
			mainWindow.webContents.send('get-reply', ['data_blocketa', etaTime.toISOString().substr(11, 8)+'s']);
			mainWindow.webContents.send('get-reply', ['data_revenue', ((totalgps * 86400 / current_target) * (current_reward / 40)).toFixed(2)]);

			logger.info('share ('+miner.login+') '+miner.difficulty+' ('+hashrate(miner)+')');
			return miner.respose('ok',null,request);
		}
		else{

			logger.info('low diff ('+miner.login+') '+miner.difficulty);
			return miner.respose(null,{code: -32501, message: "low diff"},request);
		}
		
	}
	
	if(request && request.method && request.method == "getjobtemplate") {
		
		return miner.respose({algo:"cuckaroo",edgebits:29,proofsize:40,noncebytes:4,difficulty:parseFloat(miner.difficulty),height:current_height,job_id:seq(),pre_pow:current_hashblob+miner.nextnonce()},null,request);
	}
	else{

		logger.info("unkonwn method: "+request.method);
	}

}

var ctrl_server = net.createServer(function (localsocket) {
	updateJob('ctrlport');
});
ctrl_server.listen(global.poolconfig.ctrlport,'127.0.0.1');

var server = net.createServer(function (localsocket) {
	var minerId = seq();
	var miner = new Miner(minerId,localsocket);
	mainWindow.webContents.send('get-reply', ['data_conn',++conn]);
	connectedMiners[minerId] = miner;
	
});

server.timeout = 0;

contextMenu({
	showInspectElement: false,
	showSearchWithGoogle: false
});

let mainWindow;
		
function loadstorage(key,callback)
{
	storage.has(key,function(error,haskey) {
		if(!error && haskey)
		{
			storage.get(key,function(error,object) {
				if(!error && object)
				{
					callback(false,object);
				}
				else
				{
					callback(true);
				}
			});
		}
		else
		{
			callback(true);
		}
	});
}


var daemon_child;
var miner_child;

function runDaemonCommand(command) {
	logger.debug("Recieved Daemon Command: " + command);
	if(daemon_child)daemon_child.stdin.write(command+"\n");
}

function start_daemon() {

	var appRootDir = require('app-root-dir').get();
	var daemonpath;
	if(os.type() == 'Linux')
	{
		if(isDev()){
			daemonpath = appRootDir + '/dist/bin/linux/bittubecashd';
		}else{
			appRootDir = path.dirname(appRootDir);
			daemonpath = appRootDir + '/bin/bittubecashd';
		}
	}
	else
	{
		if(isDev()){
			daemonpath = appRootDir + '\\dist\\bin\\win\\bittubecashd.exe';
		}else{
			appRootDir = path.dirname(appRootDir);
			daemonpath = appRootDir + '\\bin\\bittubecashd.exe';
		}
	}
	const spawn = require( 'child_process' ).spawn;
	if(global.poolconfig.daemonport == 25282){
		daemon_child = spawn( daemonpath, ['--add-priority-node','mining.bittube.app','--no-zmq','--testnet']);  //add whatever switches you need here, test on command line first
	}
	else if(global.poolconfig.daemonport == 25382){
		daemon_child = spawn( daemonpath, ['--add-priority-node','mining.bittube.app','--no-zmq','--stagenet']);  //add whatever switches you need here, test on command line first
	}
	else {
		daemon_child = spawn( daemonpath, ['--add-priority-node','mining.bittube.app','--out-peers','15','--no-zmq']);  //add whatever switches you need here, test on command line first
	}
	var initial = 1;
	var buffer = '';
	daemon_child.stdout.on( 'data', data => {
		if(initial) {
			buffer+=data;
		}else{
			data = data.toString().replace(/^\s+|\s+$/g, '');
			mainWindow.webContents.send('log_daemon', buffer+data);
			buffer='';
		}
		if(buffer.includes('core RPC server started')) initial = 0;
	});
	daemon_child.stderr.on( 'data', data => {
		logger.error( data );
	});
}
function start_miner() {
	
	var appRootDir = require('app-root-dir').get();
	var minerpath;
	if(os.type() == 'Linux')
	{
		if(isDev()){
			minerpath = appRootDir + '/dist/bin/linux/miner';
		}else{
			appRootDir = path.dirname(appRootDir);
			minerpath = appRootDir + '/bin/miner';
		}
	}
	else
	{
		if(isDev()){
			minerpath = appRootDir + '\\dist\\bin\\win\\miner.exe';
		}else{
			appRootDir = path.dirname(appRootDir);
			minerpath = appRootDir + '\\bin\\miner.exe';
		}
	}
	const spawn = require( 'child_process' ).spawn;
	miner_child = spawn( minerpath, ['-w','0','--algo','cuckaroo29b','--server','127.0.0.1:'+global.poolconfig.poolport,'--user','emb']);  //add whatever switches you need here, test on command line first
	miner_child.stdout.on( 'data', data => {
		data = data.toString().replace(/^\s+|\s+$/g, '');
		mainWindow.webContents.send('log_daemon', data);
	});
	miner_child.stderr.on( 'data', data => {
		logger.error( data );
	});

}


function createWindow () {
	// Create the browser window.
	mainWindow = new BrowserWindow({
		title: 'Bittube Micropool',
		width: 1000,
		height: 800,
		minWidth: 800,
		minHeight: 310,
		webPreferences: {nodeIntegration: true},
		icon: __dirname + '/build/icon_small.png'
	})

	//mainWindow.webContents.openDevTools();

	mainWindow.setMenu(null);

	mainWindow.loadFile('index.html');

	ipcMain.on('run',(event,arg) => {
		if(arg[0] === "resetData") resetData();
		if(arg[0] === "updateWallet") updateWallet();
		if(arg[0] === "runDaemonCommand") runDaemonCommand(arg[1]);
	});

	ipcMain.on('init',() => {
		loadstorage('poolport',function(error,object) {
			if(!error) global.poolconfig.poolport = object;
			loadstorage('ctrlport',function(error,object) {
				if(!error) global.poolconfig.ctrlport = object;
				loadstorage('daemonport',function(error,object) {
					if(!error) global.poolconfig.daemonport = object;
					loadstorage('mining_address',function(error,object) {
						if(!error) global.poolconfig.mining_address = object;
						loadstorage('emb_miner',function(error,object) {
							if(!error) global.poolconfig.emb_miner = object;
							loadstorage('emb_daemon',function(error,object) {
								if(!error) global.poolconfig.emb_daemon = object;
								loadstorage('daemonhost',function(error,object) {
									if(!error) global.poolconfig.daemonhost = object;
									
									
									Object.keys(ifaces).forEach(function (ifname) {
										var alias = 0;

										ifaces[ifname].forEach(function (iface) {
											if ('IPv4' !== iface.family || iface.internal !== false) {
												return;
											}

											if (alias >= 1) {
												mainWindow.webContents.send('local_ip',iface.address);
											} else {
												mainWindow.webContents.send('local_ip',iface.address);
											}
											++alias;
										});
									});
									
									mainWindow.webContents.send('set','daemonport', global.poolconfig.daemonport);
									mainWindow.webContents.send('set','ctrlport', global.poolconfig.ctrlport);
									mainWindow.webContents.send('set','poolport', global.poolconfig.poolport);
									mainWindow.webContents.send('set','mining_address', global.poolconfig.mining_address);
									mainWindow.webContents.send('set','emb_miner', global.poolconfig.emb_miner);
									mainWindow.webContents.send('set','emb_daemon', global.poolconfig.emb_daemon);
									mainWindow.webContents.send('set','daemonhost', global.poolconfig.daemonhost);
									if(global.poolconfig.poolport) {
										logger.info("start bittubecash mining server, port "+global.poolconfig.poolport);
										server.listen(global.poolconfig.poolport,'0.0.0.0');
									}
									
									if(global.poolconfig.emb_daemon == 1) {
										start_daemon();
									}
									
									if(global.poolconfig.emb_miner == 1) {
										start_miner();
									}
									
									setInterval(function(){updateJob('timer');}, 100);


								});
							});
						});
					});
				});
			});
		});
	});
	
	ipcMain.on('set',(event,arg) => {
		if(arg[0] === "mining_address") global.poolconfig.mining_address=arg[1];
		if(arg[0] === "daemonport") global.poolconfig.daemonport=arg[1];
		if(arg[0] === "daemonhost") global.poolconfig.daemonhost=arg[1];
		if(arg[0] === "poolport"){
			if(arg[1] != global.poolconfig.poolport) {
				global.poolconfig.poolport=arg[1];
				if(global.poolconfig.poolport) {
					server.close(function(){
						logger.info("start bittubecash mining server, port "+global.poolconfig.poolport);
						server.listen(global.poolconfig.poolport,'0.0.0.0');
					});
				}
			}
		}
		if(arg[0] === "ctrlport") global.poolconfig.ctrlport=arg[1];
		if(arg[0] === "emb_daemon"){
			if(arg[1] != global.poolconfig.emb_daemon) {
				global.poolconfig.emb_daemon=arg[1];
				if(global.poolconfig.emb_daemon == 1) {
					start_daemon();
				
				}else{
					if(daemon_child)daemon_child.kill();
				}
			}
		}
		if(arg[0] === "emb_miner"){
			if(arg[1] != global.poolconfig.emb_miner) {
				global.poolconfig.emb_miner=arg[1];
				if(global.poolconfig.emb_miner == 1) {
					start_miner();
				
				}else{
					if(miner_child)miner_child.kill('SIGKILL');
				}
			}
		}

		storage.set(arg[0],arg[1]);

	});
	
	mainWindow.on('closed', function () {
		mainWindow = null
	})

}

app.on('ready', createWindow)

app.on('window-all-closed', function () {
	if (process.platform !== 'darwin') {
		app.quit()
	}
})

app.on('activate', function () {
	if (mainWindow === null) {
		createWindow()
	}
})

