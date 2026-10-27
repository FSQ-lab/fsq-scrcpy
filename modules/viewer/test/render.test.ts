import assert from "node:assert/strict";import test from "node:test";import { drawFrame,type CanvasPort,type MainFrame } from "../src/app.js";
test("Canvas backing size is exact and DPR2 CSS size preserves source pixels",()=>{const calls:unknown[][]=[],sizes:number[][]=[],canvas:CanvasPort={width:0,height:0,css:(width,height)=>sizes.push([width,height]),context:()=>({drawImage:(...args)=>calls.push(args)})},frame:MainFrame={displayWidth:720,displayHeight:1280,close(){}};assert.equal(drawFrame(canvas,frame,2,{width:800,height:800}),true);assert.deepEqual([canvas.width,canvas.height],[720,1280]);assert.deepEqual(sizes,[[360,640]]);assert.deepEqual(calls,[[frame,0,0,720,1280]]);});
test("viewport proportional clamp never upscales source CSS size",()=>{const sizes:number[][]=[],canvas:CanvasPort={width:0,height:0,css:(width,height)=>sizes.push([width,height]),context:()=>({drawImage(){}})},frame:MainFrame={displayWidth:1280,displayHeight:720,close(){}};assert.equal(drawFrame(canvas,frame,2,{width:2000,height:2000}),true);assert.deepEqual(sizes.pop(),[640,360]);assert.equal(drawFrame(canvas,frame,1,{width:320,height:1000}),true);assert.deepEqual(sizes.pop(),[320,180]);});

test("native bitmap dimensions set exact backing/aspect without a VideoFrame wrapper or upscale",()=>{
 const sizes:number[][]=[],drawn:unknown[][]=[],canvas:CanvasPort={width:0,height:0,css:(width,height)=>sizes.push([width,height]),context:()=>({drawImage:(...args)=>drawn.push(args)})};
 const bitmap={width:2,height:1,close(){}};
 assert.equal(drawFrame(canvas,bitmap,1,{width:800,height:800}),true);
 assert.deepEqual([canvas.width,canvas.height],[2,1]);assert.deepEqual(sizes,[[2,1]]);assert.equal(drawn[0]![0],bitmap);
 const rotated={width:720,height:1280,close(){}};drawFrame(canvas,rotated,2,{width:180,height:800});
 assert.deepEqual([canvas.width,canvas.height],[720,1280]);assert.deepEqual(sizes.at(-1),[180,320]);
});
