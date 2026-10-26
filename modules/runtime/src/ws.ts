import { createRequire } from "node:module";
export interface WsAdapter {
  readonly bufferedAmount: number;
  send(parts: readonly Uint8Array[], callback: (error?: Error) => void): void;
  close(code: number): void; terminate(): void;
  onMessage(handler: (data: string | Uint8Array, binary: boolean) => void): void;
  onClose(handler: () => void): void;
  onError(handler: () => void): void;
}
interface ServerLike { handleUpgrade(request:unknown,socket:unknown,head:Uint8Array,callback:(socket:unknown)=>void):void; close(callback:(error?:Error)=>void):void }
interface WsModule { WebSocketServer:new(options:{noServer:true;perMessageDeflate:false;maxPayload:4096})=>ServerLike }
export interface WsServerAdapter { handleUpgrade(request:unknown,socket:unknown,head:Uint8Array,callback:(adapter:WsAdapter)=>void):void; close():Promise<void> }
const WsServer=(createRequire(import.meta.url)("ws") as WsModule).WebSocketServer;
export const WS_SERVER_OPTIONS=Object.freeze({noServer:true as const,perMessageDeflate:false as const,maxPayload:4096 as const});
interface SocketLike { bufferedAmount:number; send(data:Uint8Array,options:{binary:true;fin:boolean},callback:(error?:Error)=>void):void; close(code:number):void; terminate():void; on(name:string,handler:(...args:unknown[])=>void):void }
interface LogicalSend {readonly parts:readonly Uint8Array[];readonly done:(error?:Error)=>void;index:number;settled:boolean}
const rawData=(value:unknown):Uint8Array=>{ if (value instanceof Uint8Array) return new Uint8Array(value.buffer,value.byteOffset,value.byteLength); if (value instanceof ArrayBuffer) return new Uint8Array(value); if (Array.isArray(value) && value.every((part)=>part instanceof Uint8Array)) { const total=value.reduce((sum,part)=>sum+(part as Uint8Array).byteLength,0), bytes=new Uint8Array(total); let offset=0; for (const part of value as Uint8Array[]) { bytes.set(part,offset); offset+=part.byteLength; } return bytes; } throw new TypeError("Invalid WebSocket data"); };
export function createWsServerAdapter():WsServerAdapter { const server=new WsServer(WS_SERVER_OPTIONS); return Object.freeze({handleUpgrade(request:unknown,socket:unknown,head:Uint8Array,callback:(adapter:WsAdapter)=>void){server.handleUpgrade(request,socket,head,(accepted)=>callback(createWsAdapter(accepted)));},close(){return new Promise<void>((resolve,reject)=>server.close((error)=>error?reject(error):resolve()));}}); }
export function createWsAdapter(value: unknown): WsAdapter {
  if (typeof value !== "object" || value === null) throw new TypeError("Invalid WebSocket"); const socket = value as SocketLike;
  if (typeof socket.send!=="function" || typeof socket.close!=="function" || typeof socket.terminate!=="function" || typeof socket.on!=="function") throw new TypeError("Invalid WebSocket");
  const queue:LogicalSend[]=[],listeners={close:[] as (()=>void)[],error:[] as (()=>void)[]};let active:LogicalSend|undefined,closed=false,failure:Error|undefined,terminated=false,closeRequested=false;
  const settle=(item:LogicalSend,error?:Error)=>{if(item.settled)return;item.settled=true;if(active===item)active=undefined;item.done(error);if(!closed)flush();},fail=(error:Error)=>{if(closed)return;closed=true;failure=error;const items=[...(active?[active]:[]),...queue.splice(0)];active=undefined;for(const item of items)settle(item,error);},terminate=()=>{if(terminated)return;terminated=true;try{socket.terminate();}catch{}},abort=(error:Error)=>{if(closed)return;fail(error);terminate();},fragment=(item:LogicalSend)=>{if(closed)return settle(item,failure??new Error("closed"));const part=item.parts[item.index]!,last=item.index===item.parts.length-1;try{socket.send(part,{binary:true,fin:last},(error)=>{if(item.settled)return;if(error)return abort(error);if(last)return settle(item);item.index++;fragment(item);});}catch(cause){abort(cause instanceof Error?cause:new Error("send"));}},flush=()=>{if(active||closed)return;const item=queue.shift();if(!item)return;active=item;fragment(item);};
  socket.on("close",()=>{fail(new Error("closed"));for(const listener of listeners.close)listener();});socket.on("error",()=>{fail(new Error("transport"));for(const listener of listeners.error)listener();});
  return Object.freeze({ get bufferedAmount(){return socket.bufferedAmount;},send(parts:readonly Uint8Array[],callback:(error?:Error)=>void){if(!Array.isArray(parts)||parts.length<1||parts.some(part=>!(part instanceof Uint8Array)))return callback(new TypeError("Invalid WebSocket message"));if(closed)return callback(failure??new Error("closed"));queue.push({parts,index:0,done:callback,settled:false});flush();},close(code:number){if(closeRequested)return;closeRequested=true;socket.close(code);},terminate(){fail(new Error("terminated"));terminate();},onMessage(handler:(data:string|Uint8Array,binary:boolean)=>void){socket.on("message",(data,binary)=>handler(typeof data==="string"?data:rawData(data),binary===true));},onClose(handler:()=>void){listeners.close.push(handler);},onError(handler:()=>void){listeners.error.push(handler);} });
}
