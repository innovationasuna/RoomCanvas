export function rotationFromPointer(startYaw:number,startAngle:number,currentAngle:number){
  const delta=Math.atan2(Math.sin(startAngle-currentAngle),Math.cos(startAngle-currentAngle));
  return startYaw+delta;
}
export function translationFromPointer(x:number,z:number,startX:number,startZ:number,currentX:number,currentZ:number){
  return {x:x+currentX-startX,z:z+currentZ-startZ};
}
