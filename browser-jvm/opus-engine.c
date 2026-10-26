#include "opus.h"
#include <stdlib.h>
#include <stdint.h>
#include <limits.h>

typedef struct VoiceCodec { OpusEncoder* encoder; OpusDecoder* decoder; int id; struct VoiceCodec* next; } VoiceCodec;
static VoiceCodec* codecs=NULL;
static uint32_t nextCodecId=1;
static VoiceCodec* find_codec(int id) {
    for(VoiceCodec* codec=codecs;codec;codec=codec->next)if(codec->id==id)return codec;
    return NULL;
}

int voice_codec_create(int rate,int complexity) {
    int error=0;
    if(nextCodecId>INT_MAX)return 0;
    VoiceCodec* codec=calloc(1,sizeof(*codec));
    if(!codec)return 0;
    codec->encoder=opus_encoder_create(rate,1,OPUS_APPLICATION_VOIP,&error);
    if(!codec->encoder||error)goto failed;
    int bandwidth=rate==4000?1101:rate==6000?1102:rate==8000?1103:rate==12000?1104:rate<=20000?1105:1103;
    if(opus_encoder_ctl(codec->encoder,4002,rate*2)||opus_encoder_ctl(codec->encoder,4008,bandwidth)
       ||opus_encoder_ctl(codec->encoder,4010,complexity)||opus_encoder_ctl(codec->encoder,4006,1)
       ||opus_encoder_ctl(codec->encoder,4020,0)||opus_encoder_ctl(codec->encoder,4012,0)
       ||opus_encoder_ctl(codec->encoder,4022,-1000)||opus_encoder_ctl(codec->encoder,4016,0)
       ||opus_encoder_ctl(codec->encoder,4014,0))goto failed;
    codec->decoder=opus_decoder_create(rate,1,&error);
    if(!codec->decoder||error)goto failed;
    codec->id=(int)nextCodecId++;codec->next=codecs;codecs=codec;return codec->id;
failed:
    if(codec->encoder)opus_encoder_destroy(codec->encoder);
    if(codec->decoder)opus_decoder_destroy(codec->decoder);
    free(codec);return 0;
}
int voice_decoder_create(int rate) {
    int error=0;
    if(nextCodecId>INT_MAX)return 0;
    VoiceCodec* codec=calloc(1,sizeof(*codec));
    if(!codec)return 0;
    codec->decoder=opus_decoder_create(rate,1,&error);
    if(!codec->decoder||error){if(codec->decoder)opus_decoder_destroy(codec->decoder);free(codec);return 0;}
    codec->id=(int)nextCodecId++;codec->next=codecs;codecs=codec;return codec->id;
}
int voice_codec_destroy(int id) {
    VoiceCodec** link=&codecs;
    while(*link&&(*link)->id!=id)link=&(*link)->next;
    if(!*link)return -1;
    VoiceCodec* codec=*link;*link=codec->next;
    if(codec->encoder)opus_encoder_destroy(codec->encoder);
    opus_decoder_destroy(codec->decoder);free(codec);return 0;
}
int voice_codec_encode(int id,const opus_int16* samples,int count,unsigned char* output,int capacity) {
    VoiceCodec* codec=find_codec(id);
    if(!codec||!codec->encoder||!samples||!output||count<1||capacity<1)return OPUS_BAD_ARG;
    return opus_encode(codec->encoder,samples,count,output,capacity);
}
int voice_codec_decode(int id,const unsigned char* packet,int length,opus_int16* output,int capacity) {
    VoiceCodec* codec=find_codec(id);
    if(!codec||!packet||length<1||!output||capacity<1)return OPUS_BAD_ARG;
    return opus_decode(codec->decoder,packet,length,output,capacity,0);
}
