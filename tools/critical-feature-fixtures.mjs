export function fixtureFeatureDeclarations(pinDiameter=.07){
  const half=pinDiameter/2+.05;
  return [
    {id:'pin-shaft',kind:'solid',boundsMm:[[5-half,-half,3.35],[5+half,half,4.85]],minRetention:.9},
    {id:'through-hole',kind:'void-channel',axis:'z',boundsMm:[[-5.4,-1.4,.05],[-2.6,1.4,2.95]],minRetention:.9},
  ];
}
