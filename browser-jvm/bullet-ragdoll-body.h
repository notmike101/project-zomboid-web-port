// Real ragdoll body and joint ownership, derived from the original constructor/activation protocol.
#include "BulletDynamics/ConstraintSolver/btHingeConstraint.h"
#include "BulletDynamics/ConstraintSolver/btConeTwistConstraint.h"
struct OwnedRagdoll {
    std::shared_ptr<NativeRagdollTemplate> definition;
    std::array<double,11> massFractions{};
    std::vector<std::unique_ptr<btMotionState>> motion;
    std::vector<std::unique_ptr<btRigidBody>> bodies;
    std::vector<std::unique_ptr<btTypedConstraint>> joints;
    bool active=false;
};
static std::map<int,std::unique_ptr<OwnedRagdoll>> ownedRagdolls;
static double ragdollMass=70;
static OwnedRagdoll* findRagdoll(int id){auto entry=ownedRagdolls.find(id);return entry==ownedRagdolls.end()?nullptr:entry->second.get();}
extern "C" int set_ragdoll_active(int id,int active){
    auto* owner=findRagdoll(id);if(!ownedWorld||(active!=0&&active!=1))return 0;if(!owner)return 1;
    if(owner->active==bool(active))return 1;
    if(active){
        for(auto& body:owner->bodies){body->setLinearVelocity(btVector3(0,0,0));body->setAngularVelocity(btVector3(0,0,0));body->activate(true);ownedWorld->world.addRigidBody(body.get(),8,7);}
        for(auto& joint:owner->joints){joint->setEnabled(true);ownedWorld->world.addConstraint(joint.get(),true);}
    }else{
        for(auto& body:owner->bodies){ownedWorld->world.removeRigidBody(body.get());body->activate(true);}
        for(auto& joint:owner->joints){ownedWorld->world.removeConstraint(joint.get());joint->setEnabled(false);}
    }
    owner->active=active;return 1;
}
extern "C" int remove_ragdoll(int id){
    auto* owner=findRagdoll(id);if(!ownedWorld)return 0;if(!owner)return 1;
    if(owner->active&&!set_ragdoll_active(id,0))return 0;
    ownedRagdolls.erase(id);return 1;
}
extern "C" int clear_ragdolls(){
    if(!ownedWorld)return ownedRagdolls.empty()?1:0;
    while(!ownedRagdolls.empty())if(!remove_ragdoll(ownedRagdolls.begin()->first))return 0;return 1;
}
extern "C" int ragdoll_body_contains(const btCollisionObject* body){
    for(const auto& entry:ownedRagdolls)for(const auto& candidate:entry.second->bodies)if(candidate.get()==body)return 1;return 0;
}
extern "C" int add_ragdoll(int id,const float* partData,const float* dynamics,const float* joints,int jointCount){
    if(!ownedWorld||!ragdollTemplate||!partData||!dynamics||!joints||id<0||ownedRagdolls.count(id)||jointCount!=10)return 0;
    std::array<const float*,11> parts{},tuning{};std::array<const float*,10> jointData{};
    for(int row=0;row<11;row++){
        const float* part=partData+row*10;const float* dynamic=dynamics+row*8;
        for(int i=0;i<10;i++)if(!std::isfinite(part[i]))return 0;
        for(int i=0;i<8;i++)if(!std::isfinite(dynamic[i]))return 0;
        if(part[0]<0||part[0]>=11||std::floor(part[0])!=part[0]||dynamic[0]<0||dynamic[0]>=11||std::floor(dynamic[0])!=dynamic[0]||part[6]<=0)return 0;
        int p=int(part[0]),d=int(dynamic[0]);if(parts[p]||tuning[d])return 0;parts[p]=part;tuning[d]=dynamic;
    }
    for(int row=0;row<jointCount;row++){
        const float* joint=joints+row*22;for(int i=0;i<22;i++)if(!std::isfinite(joint[i]))return 0;
        if(joint[0]<0||joint[0]>=10||std::floor(joint[0])!=joint[0]||(joint[1]!=4&&joint[1]!=5)||joint[2]<0||joint[2]>=11||std::floor(joint[2])!=joint[2]||joint[3]<0||joint[3]>=11||std::floor(joint[3])!=joint[3])return 0;
        int index=int(joint[0]);if(jointData[index])return 0;jointData[index]=joint;
    }
    auto pending=std::make_unique<OwnedRagdoll>();pending->definition=ragdollTemplate;
    for(int part=0;part<11;part++){
        const int a=ragdollBonePairs[part][0],b=ragdollBonePairs[part][1];const auto& first=pending->definition->world[a];const auto& second=pending->definition->world[b];
        btVector3 direction=first.getOrigin()-second.getOrigin();if(pending->definition->parents[a]==b)direction=-direction;
        btQuaternion rotation;if(direction.length2()==0)rotation=btQuaternion(0,0,0,1);else rotation=shortestArcQuat(btVector3(0,1,0),direction.normalized());
        btTransform transform(rotation,(first.getOrigin()+second.getOrigin())*.5);
        pending->massFractions[part]=parts[part][6];double mass=ragdollMass*pending->massFractions[part];btVector3 inertia;pending->definition->parts[part]->calculateLocalInertia(mass,inertia);
        auto motion=std::make_unique<btDefaultMotionState>(transform);btRigidBody::btRigidBodyConstructionInfo info(mass,motion.get(),pending->definition->parts[part].get(),inertia);
        auto body=std::make_unique<btRigidBody>(info);body->setFlags(0);const float* config=tuning[part];body->setDamping(config[1],config[2]);body->setDeactivationTime(config[3]);body->setSleepingThresholds(config[4],config[5]);body->setFriction(config[6]);body->setRollingFriction(config[7]);
        pending->motion.push_back(std::move(motion));pending->bodies.push_back(std::move(body));
    }
    for(int index=0;index<10;index++){
        const float* record=jointData[index];btTransform first,second;first.setIdentity();second.setIdentity();
        first.getBasis().setEulerZYX(record[4],record[5],record[6]);second.getBasis().setEulerZYX(record[7],record[8],record[9]);first.setOrigin(btVector3(record[10],record[11],record[12]));second.setOrigin(btVector3(record[13],record[14],record[15]));
        auto& a=*pending->bodies[int(record[2])];auto& b=*pending->bodies[int(record[3])];
        if(record[1]==4){auto joint=std::make_unique<btHingeConstraint>(a,b,first,second,false);joint->setLimit(record[16],record[17],double(float(.9)),double(float(.3)),1);pending->joints.push_back(std::move(joint));}
        else{auto joint=std::make_unique<btConeTwistConstraint>(a,b,first,second);joint->setLimit(record[16],record[17],record[18],1,double(float(.3)),1);pending->joints.push_back(std::move(joint));}
    }
    ownedRagdolls.emplace(id,std::move(pending));return 1;
}
extern "C" int ragdoll_simulation_state(int id){
    auto* owner=findRagdoll(id);if(!ownedWorld||!owner)return -1;int state=0;
    for(const auto& body:owner->bodies){int current=body->getActivationState();if(state&&state!=current)return 0;state=current;}return state;
}
extern "C" int ragdoll_body_state(int id,int part,double* output){
    auto* owner=findRagdoll(id);if(!owner||part<0||part>=11||!output)return 0;const auto& body=*owner->bodies[part];const auto& transform=body.getWorldTransform();
    int cursor=0;for(int row=0;row<3;row++)for(int col=0;col<3;col++)output[cursor++]=transform.getBasis()[row][col];for(int axis=0;axis<3;axis++)output[cursor++]=transform.getOrigin()[axis];
    output[12]=body.getInvMass();for(int axis=0;axis<3;axis++)output[13+axis]=body.getInvInertiaDiagLocal()[axis];output[16]=body.getFriction();output[17]=body.getRestitution();output[18]=body.getRollingFriction();output[19]=body.getLinearDamping();output[20]=body.getAngularDamping();output[21]=body.getCollisionFlags();output[22]=body.getActivationState();output[23]=body.getDeactivationTime();output[24]=body.getLinearSleepingThreshold();return 1;
}
