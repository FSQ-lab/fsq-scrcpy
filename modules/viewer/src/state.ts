export const VIEWER_STATES=["authorizing","connecting","syncing","live","paused","interrupted","disconnected","stopped","unsupported","error"] as const;
export type ViewerState=(typeof VIEWER_STATES)[number];
export type ViewerEvent={readonly type:"connected"}|{readonly type:"syncing"}|{readonly type:"painted-fresh"}|{readonly type:"visibility";readonly visible:boolean}|{readonly type:"worker";readonly state:Exclude<ViewerState,"authorizing"|"live">}|{readonly type:"terminal";readonly state:"disconnected"|"stopped"|"unsupported"|"error"}|{readonly type:"retry"};
const terminal=(state:ViewerState)=>state==="disconnected"||state==="stopped"||state==="unsupported"||state==="error";
export function reduceViewerState(state:ViewerState,event:ViewerEvent):ViewerState{
 if(event.type==="retry")return"authorizing";if(terminal(state))return state;
 switch(event.type){case"connected":return"connecting";case"syncing":return"syncing";case"painted-fresh":return state==="syncing"?"live":state;case"visibility":return event.visible?"syncing":"paused";case"worker":return event.state;case"terminal":return event.state;}
}
