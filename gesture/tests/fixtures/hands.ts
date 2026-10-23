import type {Hand,Side} from '../../src/shared/types';
export function hand(side:Side='Right',pinch=false,x=0.5):Hand{
 const p=Array.from({length:21},()=>({x,y:0.7,z:0}));
 const set=(i:number,dx:number,y:number)=>p[i]={x:x+dx,y,z:0};
 set(0,0,.8);set(1,-.09,.7);set(2,-.15,.61);set(3,-.19,.52);set(4,-.24,.46);
 for(const [mcp,dx] of [[5,-.1],[9,0],[13,.08],[17,.15]]){
  set(mcp,dx,.59);set(mcp+1,dx,.46);set(mcp+2,dx,.34);set(mcp+3,dx,.23);
 }
 if(pinch)p[4]={...p[8],x:p[8].x+.01};
 return {side,score:.95,landmarks:p,world:p.map(v=>({...v}))};
}

export function fist(side:Side='Left',x=.8):Hand{
 const h=hand(side,false,x);
 for(const [tip,mcp] of [[8,5],[12,9],[16,13],[20,17]])h.landmarks[tip]={...h.landmarks[mcp],y:.73};
 h.landmarks[4]={...h.landmarks[8],x:h.landmarks[8].x+.01};
 h.world=h.landmarks.map(p=>({...p}));return h;
}

// 成圈的数字 3：拇指与弯曲食指相接，另三指伸直。
export function circleThree(x=.8):Hand {
 const h=hand('Left',false,x);
 h.landmarks[7]={x:x-.16,y:.43,z:0};
 h.landmarks[8]={x:x-.18,y:.52,z:0};
 h.landmarks[4]={...h.landmarks[8],x:h.landmarks[8].x+.01};
 h.world=h.landmarks.map(p=>({...p}));
 return h;
}
