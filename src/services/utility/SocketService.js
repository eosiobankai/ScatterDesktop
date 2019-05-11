import ApiService from '../apis/ApiService';
import AuthorizedApp from '../../models/AuthorizedApp';
import * as Actions from '../../store/constants';
const http = window.require('http');
const https = window.require('https');

import {Popup} from '../../models/popups/Popup'
import PopupService from './PopupService';

import {remote} from "../../util/ElectronHelpers";
import StoreService from "./StoreService";

const WebSocket = window.require('ws');

remote.getGlobal('appShared').QuitWatcher = () => {
	SocketService.broadcastEvent('dced', {});
};


/***
 * Gets certs that allow for `wss` local connections.
 * @returns {Promise<Response | never | void>}
 */
const getCerts = async () => {
	return fetch('https://certs.get-scatter.com?rand='+Math.round(Math.random()*100 + 1))
		.then(res => res.json())
		.catch(() => console.error('Could not fetch certs. Probably due to a proxy, vpn, or firewall.'));
};


let openConnections = {};

const emit = (socket, path, data) => {
	socket.send('42/scatter,' + JSON.stringify([path, data]));
}

let rekeyPromise;
const getNewKey = socket => new Promise((resolve, reject) => {
	rekeyPromise = {resolve, reject};
	emit(socket, 'rekey');
	return rekeyPromise;
});

function heartbeat() { this.isAlive = true; }

const socketHandler = (socket) => {
	let origin = null;


	// When something connects we automatically
	// notify it of a successful connection
	// https://get-scatter.com/docs/native-connect
	socket.send("40");
	socket.send("40/scatter");
	socket.send(`42/scatter,["connected"]`);

	socket.on('message', msg => {
		if(msg.indexOf('42/scatter') === -1) return false;

		const [type, data] = JSON.parse(msg.replace('42/scatter,', ''));

		switch(type){
			case 'pair':        return handlePairedResponse(data);
			case 'rekeyed':     return handleRekeyResponse(data);
			case 'api':         return handleApiResponse(data);
		}
	});

	socket.on('disconnect', async request => {
		console.log('dc', request);
		delete openConnections[origin];
	});

	socket.on('error', async request => {
		console.log('error', request);
	});

	// All authenticated api requests pass through the 'api' route.
	const handleApiResponse = async request => {
		if(!request.plugin || request.plugin.length > 35) return emit(socket, 'api', {id:request.id, result:null});
		request.plugin = request.plugin.replace(/\s/g, "");

		// 2 way authentication
		const existingApp = StoreService.get().state.scatter.keychain.findApp(request.data.payload.origin);

		const updateNonce = async () => {
			const clone = StoreService.get().state.scatter.clone();
			existingApp.nextNonce = request.data.nextNonce;
			clone.keychain.updateOrPushApp(existingApp);
			return StoreService.get().dispatch(Actions.SET_SCATTER, clone);
		};

		const removeAppPermissions = async () => {
			const clone = StoreService.get().state.scatter.clone();
			clone.keychain.removeApp(existingApp);
			return StoreService.get().dispatch(Actions.SET_SCATTER, clone);
		};


		if(!existingApp) return;
		if(!existingApp.checkKey(request.data.appkey)) return;
		if(existingApp.nextNonce.length && !existingApp.checkNonce(request.data.nonce)) await removeAppPermissions();
		else await updateNonce();

		if(!origin){
			origin = existingApp.origin;
			openConnections[origin] = socket;
		}

		emit(socket, 'api', await ApiService.handler(Object.assign(request.data, {plugin:request.plugin})));
	};

	const handleRekeyResponse = request => {
		rekeyPromise.resolve(request);
	};

	const handlePairedResponse = async request => {
		const scatter = StoreService.get().state.scatter;
		const existingApp = scatter.keychain.findApp(request.data.origin);
		const linkApp = {
			type:'linkApp',
			payload:request.data
		};

		if(request.data.passthrough)
			return emit(socket, 'paired', existingApp && existingApp.checkKey(request.data.appkey));

		const addAuthorizedApp = async (newKey = null) => {
			const authedApp = new AuthorizedApp(request.data.origin, newKey ? newKey : request.data.appkey);
			const clone = scatter.clone();
			clone.keychain.updateOrPushApp(authedApp);
			await StoreService.get().dispatch(Actions.SET_SCATTER, clone);
			emit(socket, 'paired', true);
		};

		const repair = async () => {
			const newKey = await getNewKey(socket);
			if(newKey.data.origin !== request.data.origin || newKey.data.appkey.indexOf('appkey:') === -1) return emit(socket, 'paired', false);
			return addAuthorizedApp(newKey.data.appkey)
		}

		if(existingApp){
			if(existingApp.checkKey(request.data.appkey)) return emit(socket, 'paired', true);
			else PopupService.push(Popup.popout(linkApp, async ({result}) => {
				if(result) return repair();
				else emit(socket, 'paired', false);
			}));
		}
		else return repair();
	};
};


let ws, wss;
export default class SocketService {

	static async initialize(){

		// HTTP protocol (port 50005)
		const httpServer = http.createServer();
		ws = new WebSocket.Server({ server:httpServer });
		httpServer.listen(50005);

		// HTTPS protocol (port 50006)
		const certs = await getCerts();
		if(certs && certs.hasOwnProperty('key') && certs.hasOwnProperty('cert')){
			const httpsServer = https.createServer(certs);
			wss = new WebSocket.Server({ server:httpsServer });
			httpsServer.listen(50006);
		} else {
			PopupService.push(Popup.prompt("Couldn't fetch certificates",
				'There was an issue trying to fetch the certificates which allow Scatter to run on SSL. This is usually caused by proxies, firewalls, and anti-viruses.'))
		}

		ws.on('connection', socket => socketHandler(socket));
		if(wss) wss.on('connection', socket => socketHandler(socket));
		return true;
	}

	static async close(){
		console.log('closing')
		// Getting namespace
		if(!ws && !wss) return;

		ws.clients.map(ws => ws.terminate());
		if(wss) wss.clients.map(ws => ws.terminate());

		return true;
	}

	static sendEvent(event, payload, origin){
		if(!openConnections.hasOwnProperty(origin)) return false;
		const socket = openConnections[origin];
		emit(socket, 'event', {event, payload});
		return true;
	}

	static broadcastEvent(event, payload){
		Object.keys(openConnections).map(origin => {
			this.sendEvent(event, payload, origin);
		});
		return true;
	}

}