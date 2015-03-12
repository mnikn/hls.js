/*
 * buffer controller
 *
 */

 import Event                from '../events';
 import FragmentLoader       from '../loader/fragment-loader';
 import observer             from '../observer';
 import {logger}             from '../utils/logger';
 import Demuxer              from '../demux/demuxer';

  const IDLE = 0;
  const LOADING = 1;
  const WAITING_LEVEL = 2;
  const PARSING = 3;
  const PARSED = 4;
  const APPENDING = 5;

 class BufferController {

  constructor(video,levelController) {
    this.video = video;
    this.levelController = levelController;
    this.fragmentLoader = new FragmentLoader();
    this.mp4segments = [];
    // Source Buffer listeners
    this.onsbue = this.onSourceBufferUpdateEnd.bind(this);
    this.onsbe  = this.onSourceBufferError.bind(this);
    // internal listeners
    this.onfr = this.onFrameworkReady.bind(this);
    this.onmp = this.onManifestParsed.bind(this);
    this.onll = this.onLevelLoaded.bind(this);
    this.onfl = this.onFragmentLoaded.bind(this);
    this.onis = this.onInitSegment.bind(this);
    this.onfpg = this.onFragmentParsing.bind(this);
    this.onfp = this.onFragmentParsed.bind(this);
    this.ontick = this.tick.bind(this);
    this.state = IDLE;
    this.waitlevel = false;
    observer.on(Event.FRAMEWORK_READY, this.onfr);
    observer.on(Event.MANIFEST_PARSED, this.onmp);
  }

  destroy() {
    this.stop();
    this.fragmentLoader.destroy();
    if(this.demuxer) {
      this.demuxer.destroy();
      this.demuxer = null;
    }
    this.mp4segments = [];
    var sb = this.sourceBuffer;
    if(sb) {
      //detach sourcebuffer from Media Source
      this.mediaSource.removeSourceBuffer(sb);
      sb.removeEventListener('updateend', this.onsbue);
      sb.removeEventListener('error', this.onsbe);
      this.sourceBuffer = null;
    }
    observer.removeListener(Event.FRAMEWORK_READY, this.onfr);
    observer.removeListener(Event.MANIFEST_PARSED, this.onmp);
    this.state = IDLE;
  }

  start() {
    this.stop();
    this.timer = setInterval(this.ontick, 100);
    observer.on(Event.FRAGMENT_LOADED, this.onfl);
    observer.on(Event.INIT_SEGMENT, this.onis);
    observer.on(Event.FRAGMENT_PARSING, this.onfpg);
    observer.on(Event.FRAGMENT_PARSED, this.onfp);
    observer.on(Event.LEVEL_LOADED, this.onll);
  }

  stop() {
    if(this.timer) {
      clearInterval(this.timer);
    }
    this.timer = undefined;
    observer.removeListener(Event.FRAGMENT_LOADED, this.onfl);
    observer.removeListener(Event.FRAGMENT_PARSED, this.onfp);
    observer.removeListener(Event.FRAGMENT_PARSING, this.onfpg);
    observer.removeListener(Event.LEVEL_LOADED, this.onll);
    observer.removeListener(Event.INIT_SEGMENT, this.onis);
  }

  tick() {
    switch(this.state) {
      case LOADING:
        // nothing to do, wait for fragment retrieval
      case WAITING_LEVEL:
        // nothing to do, wait for level retrieval
      case PARSING:
        // nothing to do, wait for fragment being parsed
        break;
      case PARSED:
      case APPENDING:
        if (this.sourceBuffer) {
          // if MP4 segment appending in progress nothing to do
          if(this.sourceBuffer.updating) {
            //logger.log('sb append in progress');
        // check if any MP4 segments left to append
          } else if(this.mp4segments.length) {
            this.sourceBuffer.appendBuffer(this.mp4segments.shift());
            this.state = APPENDING;
          }
        }
        break;
      case IDLE:
        // determine next candidate fragment to be loaded, based on current position and
        //  end of buffer position
        //  ensure 60s of buffer upfront
        var v = this.video,
            pos = v.currentTime,
            buffered = v.buffered,
            bufferLen,
            // bufferStart and bufferEnd are buffer boundaries around current video position
            bufferStart,bufferEnd,
            i;
        for(i = 0, bufferLen = 0, bufferStart = bufferEnd = pos ; i < buffered.length ; i++) {
          //logger.log('buf start/end:' + buffered.start(i) + '/' + buffered.end(i));
          if((pos+0.04) >= buffered.start(i) && pos < buffered.end(i)) {
            // play position is inside this buffer TimeRange, retrieve end of buffer position and buffer length
            bufferStart = buffered.start(i);
            bufferEnd = buffered.end(i);
            bufferLen = bufferEnd - pos;
          }
        }
        // if buffer length is less than 60s try to load a new fragment
        if(bufferLen < 60) {
          var loadLevel;
          if(this.waitlevel === false) {
            // determine loading level
            if(this.justStarted === true) {
              // get start level from level Controller
              loadLevel = this.levelController.startLevel();
              this.justStarted = false;
            } else {
              // we are not at playback start, get best level from level Controller
              loadLevel = this.levelController.bestLevel();
            }
            if(loadLevel !== this.levelController.level) {
              // set new level to playlist loader : this will trigger a playlist load if needed
              this.level = this.levelController.level = loadLevel;
              // tell demuxer that we will switch level (this will force init segment to be regenerated)
              if (this.demuxer) {
                this.demuxer.switchLevel();
              }
            }
          } else {
            // load level is retrieved from level Controller
            loadLevel = this.level;
          }
          var level = this.levels[loadLevel];
          // if level not retrieved yet, switch state and wait for playlist retrieval
          if(typeof level.data === 'undefined') {
            this.state = WAITING_LEVEL;
            this.waitlevel = true;
          } else {
            // find fragment index, contiguous with end of buffer position
            var fragments = level.data.fragments, frag;
            if(bufferLen > 0 && buffered.length === 1) {
              i = this.lastSN + 1 - fragments[0].sn;
              frag = fragments[i];
            } else {
              // no data buffered, look for fragments matching with current play position
              for (i = 0; i < fragments.length ; i++) {
                frag = fragments[i];
                // offset should be within fragment boundary
                if(frag.start <=  bufferEnd && (frag.start + frag.duration) > bufferEnd) {
                  break;
                }
              }
              logger.log('find SN matching with pos:' +  bufferEnd + ':' + frag.sn);
            }
            if(i >= 0 && i < fragments.length) {
              this.waitlevel = false;
              if(frag.sn === this.lastSN) {
                if(i === (fragments.length -1)) {
                  // we are at the end of the playlist and we already loaded last fragment, don't do anything
                  return;
                } else {
                  frag = fragments[i+1];
                  logger.log('SN just loaded, load next one:' + frag.sn);
                }
              }
              logger.log('Loading       ' + frag.sn + ' of [' + fragments[0].sn + ',' + fragments[fragments.length-1].sn + '],level '  + loadLevel);
              //logger.log('      loading frag ' + i +',pos/bufEnd:' + pos.toFixed(3) + '/' + bufferEnd.toFixed(3));
              this.lastSN = frag.sn;
              this.fragmentLoader.load(frag.url);
              this.state = LOADING;
            }
          }
        }
        break;
      default:
        break;
    }
  }

  onFrameworkReady(event,data) {
    this.mediaSource = data.mediaSource;
  }

  onManifestParsed(event,data) {
    this.levels = data.levels;
    this.justStarted = true;
    this.start();
  }

  onLevelLoaded(event,data) {
    // merge level info
    this.levels[data.id].data = data.level;
    var duration = data.level.totalduration;
    if(!this.demuxer) {
      this.demuxer = new Demuxer(duration);
    }
    var fragments = data.level.fragments;
    logger.log('level ' + data.id + ' loaded [' + fragments[0].sn + ',' + fragments[fragments.length-1].sn + '],duration:' + duration);
    this.state = IDLE;
    //trigger handler right now
    this.tick();
  }

  onFragmentLoaded(event,data) {
    if(this.state === LOADING) {
      this.state = PARSING;
      // transmux the MPEG-TS data to ISO-BMFF segments
      this.tparse0 = Date.now();
      this.parselen = data.payload.byteLength;
      this.demuxer.push(data.payload,this.levels[this.level].codecs);
      var stats,rtt,loadtime,bw;
      stats = data.stats;
      rtt = stats.tfirst - stats.trequest;
      loadtime = stats.tend - stats.trequest;
      bw = stats.length*8/(1000*loadtime);
      //logger.log(data.url + ' loaded, RTT(ms)/load(ms)/bitrate:' + rtt + '/' + loadtime + '/' + bw.toFixed(3) + ' Mb/s');
    }
  }

  onInitSegment(event,data) {
    // check if codecs have been explicitely defined in the master playlist for this level;
    // if yes use these ones instead of the ones parsed from the demux
    var codec = this.levels[this.level].codecs;
    //logger.log('playlist codecs:' + codec);
    if(codec === undefined) {
      codec = data.codec;
    }
    // codec="mp4a.40.5,avc1.420016";
    // force HE-AAC for audio (some browsers don't support audio codec switch that could happen in adaptive playlists)
    //don't do it for mono streams ...
    if(data.audioChannelCount === 2 && navigator.userAgent.toLowerCase().indexOf('android') === -1) {
      codec = codec.replace('mp4a.40.2','mp4a.40.5');
    }
    logger.log('playlist/choosed codecs:' + this.levels[this.level].codecs + '/' + codec);
    if(!this.sourceBuffer) {
      // create source Buffer and link them to MediaSource
      var sb = this.sourceBuffer = this.mediaSource.addSourceBuffer('video/mp4;codecs=' + codec);
      sb.addEventListener('updateend', this.onsbue);
      sb.addEventListener('error', this.onsbe);
    }
    this.mp4segments.push(data.moov);
    //trigger handler right now
    this.tick();
  }

  onFragmentParsing(event,data) {
    this.tparse2 = Date.now();
    logger.log('      parsed data, type/start/end:' + data.type + '/' + data.start.toFixed(3) + '/' + data.end.toFixed(3) );
    this.mp4segments.push(data.moof);
    this.mp4segments.push(data.mdat);
    //trigger handler right now
    this.tick();
  }

  onFragmentParsed() {
    this.state = PARSED;
    this.tparse2 = Date.now();
    //logger.log('      parsing len/duration/rate:' + (this.parselen/1000000).toFixed(2) + 'MB/'  + (this.tparse2-this.tparse0) +'ms/' + ((this.parselen/1000)/(this.tparse2-this.tparse0)).toFixed(2) + 'MB/s');
     //trigger handler right now
    this.tick();
  }

  onSourceBufferUpdateEnd() {
    //trigger handler right now
    if(this.mp4segments.length === 0)  {
      //logger.log('appending finished');
      this.state = IDLE;
    }
    this.tick();
  }

  onSourceBufferError(event) {
      logger.log(' buffer append error:' + event);
  }
}

export default BufferController;
