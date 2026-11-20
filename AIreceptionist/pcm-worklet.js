class PCMCapture extends AudioWorkletProcessor {
  constructor(){super();this.ratio=sampleRate/16000;this.position=0;this.total=0;this.samples=0;this.chunk=[];this.power=0;}
  process(inputs,outputs){
    const input=inputs[0]?.[0];
    if(input)for(let i=0;i<input.length;i++){
      this.total+=input[i];this.samples++;this.position++;
      if(this.position>=this.ratio){
        const sample=Math.max(-1,Math.min(1,this.total/this.samples));this.chunk.push(Math.round(sample*32767));this.power+=sample*sample;
        this.position-=this.ratio;this.total=0;this.samples=0;
        if(this.chunk.length===800){const pcm=new Int16Array(this.chunk);this.port.postMessage({pcm:pcm.buffer,level:Math.sqrt(this.power/800)},[pcm.buffer]);this.chunk=[];this.power=0;}
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture',PCMCapture);
