// Original ragdoll template geometry. Live body simulation is a separate owner.
#include "BulletCollision/CollisionShapes/btCapsuleShape.h"
struct NativeRagdollCapsule final:btCapsuleShape {
    NativeRagdollCapsule(double radius,double height):btCapsuleShape(radius,height){m_collisionMargin=.04;setUserIndex2(0x505a5244);}
    btVector3 localGetSupportingVertexWithoutMargin(const btVector3& input)const override{
        btVector3 direction=input;double length=direction.length2();
        if(length<.0001)direction=btVector3(1,0,0);else direction*=1/std::sqrt(length);
        btVector3 top(0,getHalfHeight(),0),bottom(0,-getHalfHeight(),0);
        btVector3 radial=(direction*getLocalScaling())*getRadius()-direction*getMargin();
        top+=radial;bottom+=radial;return direction.dot(bottom)>direction.dot(top)?bottom:top;
    }
    void batchedUnitVectorGetSupportingVertexWithoutMargin(const btVector3* input,btVector3* output,int count)const override{
        for(int i=0;i<count;i++)output[i]=localGetSupportingVertexWithoutMargin(input[i]);
    }
    void getAabb(const btTransform& transform,btVector3& min,btVector3& max)const override{
        btVector3 half(getRadius()+getMargin(),getRadius()+getHalfHeight()+getMargin(),getRadius()+getMargin());
        const auto basis=transform.getBasis().absolute();
        btVector3 extent=half.dot3(basis[0],basis[1],basis[2]);min=transform.getOrigin()-extent;max=transform.getOrigin()+extent;
    }
};
struct NativeRagdollTemplate {
    std::vector<int> parents;
    std::vector<btTransform> local,world;
    std::vector<std::unique_ptr<btCollisionShape>> children;
    std::vector<std::unique_ptr<btCompoundShape>> parts;
};
static std::shared_ptr<NativeRagdollTemplate> ragdollTemplate;
static constexpr int ragdollBonePairs[11][2]={{4,5},{5,6},{5,6},{20,21},{21,22},{24,25},{25,26},{8,9},{9,10},{14,15},{15,16}};
extern "C" int initialize_ragdoll_template(const int* parents,int count,const float* pose,float qx,float qy,float qz,float qw,const float* records,int recordCount){
    if(!ownedWorld||!parents||!pose||!records||count<27||count>4096||recordCount!=11)return 0;
    for(int i=0;i<count;i++){
        if((i==0&&parents[i]!=-1)||(i>0&&(parents[i]<0||parents[i]>=i)))return 0;
        for(int field=0;field<7;field++)if(!std::isfinite(pose[i*7+field]))return 0;
        if(i>0&&btQuaternion(pose[i*7+3],pose[i*7+4],pose[i*7+5],pose[i*7+6]).length2()==0)return 0;
    }
    for(float value:{qx,qy,qz,qw})if(!std::isfinite(value))return 0;
    btQuaternion root(qx,qy,qz,qw);if(root.length2()==0)return 0;
    std::array<const float*,11> definition{};
    for(int i=0;i<recordCount;i++){
        const float* record=records+i*10;for(int j=0;j<10;j++)if(!std::isfinite(record[j]))return 0;
        if(record[0]<0||record[0]>=11||std::floor(record[0])!=record[0])return 0;
        int part=int(record[0]);if(definition[part]||(record[1]!=0&&record[1]!=1)||record[2]<=0||record[5]<0||record[5]>2||int(record[5])!=record[5])return 0;
        definition[part]=record;
    }
    auto pending=std::make_shared<NativeRagdollTemplate>();pending->parents.assign(parents,parents+count);pending->local.resize(count);pending->world.resize(count);
    for(int i=0;i<count;i++){
        auto& local=pending->local[i];local.setIdentity();
        if(i==0)local.setRotation(root);
        else{local.setOrigin(btVector3(pose[i*7],pose[i*7+1],pose[i*7+2]));local.setRotation(btQuaternion(pose[i*7+3],pose[i*7+4],pose[i*7+5],pose[i*7+6]));}
        pending->world[i]=i==0?local:pending->world[parents[i]]*local;
    }
    for(int part=0;part<11;part++){
        const float* record=definition[part];double height=record[3];
        if(record[1]){auto delta=pending->world[ragdollBonePairs[part][0]].getOrigin()-pending->world[ragdollBonePairs[part][1]].getOrigin();height=std::sqrt(delta.length2())-double(record[4]);}
        std::unique_ptr<btCollisionShape> child;
        if(record[5]==0){if(height<0)return 0;child=std::make_unique<NativeRagdollCapsule>(record[2],height);}
        else if(record[5]==1)child=std::make_unique<btBoxShape>(btVector3(record[2],record[2],record[2]));
        else child=std::make_unique<btSphereShape>(record[2]);
        auto compound=std::make_unique<btCompoundShape>(true);btTransform offset;offset.setIdentity();offset.setOrigin(btVector3(record[7],record[8],record[9]));compound->addChildShape(offset,child.get());
        pending->children.push_back(std::move(child));pending->parts.push_back(std::move(compound));
    }
    ragdollTemplate=std::move(pending);return 1;
}
extern "C" int ragdoll_template_bone(int index,double* output){
    if(!ragdollTemplate||!output||index<0||index>=int(ragdollTemplate->local.size()))return 0;
    int cursor=0;for(const auto* transform:{&ragdollTemplate->world[index],&ragdollTemplate->local[index]}){
        for(int row=0;row<3;row++)for(int column=0;column<3;column++)output[cursor++]=transform->getBasis()[row][column];
        for(int axis=0;axis<3;axis++)output[cursor++]=transform->getOrigin()[axis];
    }return 1;
}
extern "C" int ragdoll_template_shape(int part,double* output){
    if(!ragdollTemplate||!output||part<0||part>=11)return 0;
    btTransform identity;identity.setIdentity();btVector3 min,max;ragdollTemplate->parts[part]->getAabb(identity,min,max);
    for(int axis=0;axis<3;axis++){output[axis]=min[axis];output[3+axis]=max[axis];}return 1;
}
