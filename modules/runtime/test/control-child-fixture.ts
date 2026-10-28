const input=JSON.parse(process.env.FSQ_CONTROL_CHILD_FIXTURE??"null")as{mode:"ready"|"contended"|"cancel";instanceId?:string;generation?:string}|null;
if(!input)process.exit(2);
if(input.mode==="contended"){process.send?.({type:"contended"});process.exit(0);}
if(input.mode==="ready")process.send?.({type:"ready",instanceId:input.instanceId,generation:input.generation});
process.on("message",message=>{const type=(message as{type?:unknown})?.type;if(type==="cancel"||type==="ready")process.exit(0);});
setInterval(()=>undefined,1_000);
