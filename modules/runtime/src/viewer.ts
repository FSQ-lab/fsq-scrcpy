import { parseStrictJson,exactObject } from "./strict-json.js"; import type { Clock } from "./clock.js"; import type { UpgradeDescriptor } from "./types.js"; import { MediaChannel } from "./media.js"; import type { WsAdapter } from "./ws.js";
export interface ViewerHooks { readonly hello:()=>void; readonly visible:(visible:boolean)=>void; readonly leaseExpired:()=>void; readonly closed:()=>void }
const U64=/^(?:0|[1-9][0-9]{0,19})$/;
export class ViewerConnection {
  #hello=false; #left=false; #closed=false; #helloTimer:object; #leaseTimer:object|undefined;
  #acks=new Float64Array(1024); #controls=new Float64Array(32); #ackHead=0; #ackCount=0; #controlHead=0; #controlCount=0;
  constructor(readonly descriptor:UpgradeDescriptor,readonly ws:WsAdapter,readonly media:MediaChannel,readonly clock:Clock,readonly hooks:ViewerHooks) { this.#helloTimer=clock.set(5_000,()=>this.reject(1008)); ws.onMessage((data,binary)=>this.message(data,binary)); ws.onClose(()=>this.finish()); ws.onError(()=>{ this.reject(1011); }); }
  message(data:string|Uint8Array,binary=false):void {
    if(this.#closed||this.#left)return;
    if(binary)return this.reject(1008);
    try {
      const bytes=typeof data==="string"?new TextEncoder().encode(data):data;
      if(bytes.byteLength>4096)return this.reject(1009);
      const value=parseStrictJson(bytes),type=value.type;
      if(!this.rate(type==="ack",this.clock.mono()))return this.reject(1008);
      if(!this.#hello){
        if(!exactObject(value,["v","type","streamId"])||value.v!==1||type!=="hello"||value.streamId!==this.descriptor.streamId)return this.reject(1008);
        this.#hello=true;this.clock.clear(this.#helloTimer);this.hooks.hello();return;
      }
      if(type==="lease-renew"){
        if(!exactObject(value,["v","type","visible","creditFrames","creditBytes"])||value.v!==1||typeof value.visible!=="boolean"||!Number.isInteger(value.creditFrames)||(value.creditFrames as number)<0||(value.creditFrames as number)>4||!Number.isInteger(value.creditBytes)||(value.creditBytes as number)<0||(value.creditBytes as number)>8_388_608)return this.reject(1008);
        if(!value.visible)this.media.visibility(false);this.hooks.visible(value.visible);
        this.media.setCredit(value.creditFrames as number,value.creditBytes as number);
        if(this.#leaseTimer)this.clock.clear(this.#leaseTimer);
        this.#leaseTimer=value.visible?this.clock.set(5_000,()=>this.hooks.leaseExpired()):undefined;return;
      }
      if(type==="ack"){
        const jpeg=this.media.minor===1;
        if(!exactObject(value,jpeg?["v","type","sequence","paintedSequence"]:["v","type","sequence"])||value.v!==1||!this.u64(value.sequence)||jpeg&&!this.u64(value.paintedSequence))return this.reject(1008);
        if(jpeg?!this.media.ackPaint(BigInt(value.sequence as string),BigInt(value.paintedSequence as string)):this.media.ack(BigInt(value.sequence as string))==="future")return this.reject(1008);
        return;
      }
      if(type==="leave"&&exactObject(value,["v","type"])&&value.v===1){this.#left=true;this.media.visibility(false);this.hooks.visible(false);this.ws.close(1000);this.finish();return;}
      this.reject(1008);
    }catch{this.reject(1008);}
  }
  reject(code:1008|1009|1011):void { if (this.#closed) return; this.ws.close(code); this.finish(); }
  private u64(value:unknown):value is string{return typeof value==="string"&&U64.test(value)&&BigInt(value)<=(1n<<64n)-1n;}
  private rate(ack:boolean,now:number):boolean {
    const bucket=ack?this.#acks:this.#controls,limit=ack?(this.media.minor===1?1024:128):32;
    let head=ack?this.#ackHead:this.#controlHead,count=ack?this.#ackCount:this.#controlCount;
    while(count&&bucket[head]!<=now-10_000){head=(head+1)%bucket.length;count--;}
    if(count>=limit)return false;
    bucket[(head+count)%bucket.length]=now;count++;
    if(ack){this.#ackHead=head;this.#ackCount=count;}else{this.#controlHead=head;this.#controlCount=count;}
    return true;
  }
  private finish():void { if (this.#closed) return; this.#closed=true; this.clock.clear(this.#helloTimer); if (this.#leaseTimer) this.clock.clear(this.#leaseTimer); this.hooks.closed(); }
}
