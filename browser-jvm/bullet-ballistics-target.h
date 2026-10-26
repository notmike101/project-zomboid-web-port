// Original ballistics target ownership: separate no-response aggregate box and detached body controller.
class NativeBallisticsBox : public btBoxShape {
public:
    explicit NativeBallisticsBox(const btVector3& half):btBoxShape(half){}
    void setNativeHalfSizes(const btVector3& half){m_implicitShapeDimensions=half;}
};
struct OwnedBallisticsTarget {
    std::unique_ptr<OwnedRagdoll> skeleton;
    std::unique_ptr<NativeBallisticsBox> shape;
    btTransform axis=btTransform::getIdentity();
    btVector3 position=btVector3(0,0,0);
    bool aggregateHit=false;
    bool bodyHit[11]={};
    btVector3 bodyHitColor[11];
    btVector3 hitPoint=btVector3(0,0,0),hitColor=btVector3(0,0,0);
    std::unique_ptr<btCollisionObject> object;
};
static std::map<int,std::unique_ptr<OwnedBallisticsTarget>> ownedBallisticsTargets;
static std::vector<std::unique_ptr<OwnedBallisticsTarget>> pooledBallisticsTargets;
static int ensure_ballistics_target_owner(int id,const float* parts,const float* dynamics,const float* joints){
    if(!ownedWorld||id<0)return -1;if(ownedBallisticsTargets.count(id))return 0;
    std::unique_ptr<OwnedBallisticsTarget> pending;
    if(pooledBallisticsTargets.empty()){
        auto skeleton=construct_ragdoll(parts,dynamics,joints,10);if(!skeleton)return -1;
        pending=std::make_unique<OwnedBallisticsTarget>();pending->skeleton=std::move(skeleton);
        pending->shape=std::make_unique<NativeBallisticsBox>(btVector3(double(float(.175)),double(float(.81649667)),double(float(.175))));
        pending->object=std::make_unique<btCollisionObject>();pending->object->setCollisionShape(pending->shape.get());pending->object->setCollisionFlags(4);
    }else{pending=std::move(pooledBallisticsTargets.front());pooledBallisticsTargets.erase(pooledBallisticsTargets.begin());}
    pending->axis.setIdentity();pending->object->setUserIndex(id);
    ownedBallisticsTargets.emplace(id,std::move(pending));return 0;
}
extern "C" int ensure_ballistics_target(int id,const float* parts,const float* dynamics,const float* joints){return ensure_ballistics_target_owner(id,parts,dynamics,joints);}
extern "C" int add_ballistics_target(int id,const float* parts,const float* dynamics,const float* joints){
    if(ensure_ballistics_target_owner(id,parts,dynamics,joints)!=0)return -1;
    auto& target=*ownedBallisticsTargets.at(id);if(target.object->getBroadphaseHandle())return 1;
    ownedWorld->world.addCollisionObject(target.object.get(),16,-1);return 0;
}
extern "C" int remove_ballistics_target(int id){
    if(!ownedWorld)return -1;auto found=ownedBallisticsTargets.find(id);if(found==ownedBallisticsTargets.end())return 0;
    const int result=found->second->object->getBroadphaseHandle()?0:1;
    if(!result)ownedWorld->world.removeCollisionObject(found->second->object.get());
    pooledBallisticsTargets.push_back(std::move(found->second));ownedBallisticsTargets.erase(found);return result;
}
struct OwnedBallisticsController {
    btTransform transform=btTransform::getIdentity(),reticle=btTransform::getIdentity();
    std::unique_ptr<btBoxShape> aperture=std::make_unique<btBoxShape>(btVector3(1,1,1));
    std::unique_ptr<btSphereShape> sphere=std::make_unique<btSphereShape>(1);
    double range=0;
    btVector3 color=btVector3(0,1,1);
};
static btTransform globalBallisticsReticle(btMatrix3x3(0,0,0,0,0,0,0,0,0),btVector3(0,0,0));
static std::map<int,std::unique_ptr<OwnedBallisticsController>> ownedBallisticsControllers;
static std::vector<std::unique_ptr<OwnedBallisticsController>> pooledBallisticsControllers;
extern "C" int clear_ballistics_targets(){
    if(!ownedWorld)return ownedBallisticsTargets.empty()?1:0;
    while(!ownedBallisticsTargets.empty())if(remove_ballistics_target(ownedBallisticsTargets.begin()->first)<0)return 0;
    pooledBallisticsTargets.clear();ownedBallisticsControllers.clear();pooledBallisticsControllers.clear();return 1;
}
// Bounded original-DLL comparison of actual ownership, geometry and detached body state.
extern "C" int ballistics_target_state(int id,int part,double* output){
    auto found=ownedBallisticsTargets.find(id);if(found==ownedBallisticsTargets.end()||!output||part<0||part>=11)return 0;
    const auto& target=*found->second;if(!target.object->getBroadphaseHandle())return 0;const auto& body=*target.skeleton->bodies[part];const auto& transform=body.getWorldTransform();int cursor=0;
    for(int row=0;row<3;row++)for(int col=0;col<3;col++)output[cursor++]=transform.getBasis()[row][col];
    for(int axis=0;axis<3;axis++)output[cursor++]=transform.getOrigin()[axis];
    output[12]=body.getInvMass();output[13]=body.getCollisionFlags();output[14]=body.getActivationState();
    btVector3 lo,hi;target.shape->getAabb(btTransform::getIdentity(),lo,hi);
    for(int axis=0;axis<3;axis++){output[15+axis]=lo[axis];output[18+axis]=hi[axis];}
    output[21]=target.object->getCollisionFlags();output[22]=target.object->getBroadphaseHandle()->m_collisionFilterGroup;output[23]=target.object->getBroadphaseHandle()->m_collisionFilterMask;return 1;
}

extern "C" int set_ballistics_target_axis(int id,float x,float y,float z){
    if(!ownedWorld)return 0;auto found=ownedBallisticsTargets.find(id);if(found==ownedBallisticsTargets.end())return 1;
    for(float value:{x,y,z})if(!std::isfinite(value))return 0;
    btQuaternion rotation=btQuaternion(btVector3(0,0,1),double(z))*btQuaternion(btVector3(0,1,0),double(y))*btQuaternion(btVector3(1,0,0),double(x));
    found->second->axis=btTransform(rotation,btVector3(0,0,0));return 1;
}
extern "C" int update_ballistics_target_skeleton(int id,int count,const float* records,const float* anchors,int anchorCount){
    if(!ownedWorld)return 0;auto found=ownedBallisticsTargets.find(id);if(found==ownedBallisticsTargets.end())return 0;
    auto& target=*found->second;auto* owner=target.skeleton.get();
    if(!records||count!=owner->definition->parents.size()||!configure_ragdoll_owner_anchors(owner,anchors,anchorCount))return 0;
    std::vector<btTransform> local(count),world(count);
    for(int i=0;i<count;i++){
        const float* row=records+i*7;for(int j=0;j<7;j++)if(!std::isfinite(row[j]))return 0;
        btQuaternion rotation(row[3],row[4],row[5],row[6]);if(rotation.length2()==0)return 0;
        local[i]=i==0?target.axis:btTransform(rotation,btVector3(row[0],row[1],row[2]));
        world[i]=i==0?local[i]:world[owner->definition->parents[i]]*local[i];
    }
    btTransform root(btQuaternion(0,0,0,1),target.position);
    for(int part=0;part<11;part++){
        auto& body=*owner->bodies[part];body.setWorldTransform(root*world[owner->anchorBones[part]]*owner->anchorOffsets[part]);
        body.setLinearVelocity(btVector3(0,0,0));body.setAngularVelocity(btVector3(0,0,0));
    }
    owner->poseLocal=std::move(local);owner->poseWorld=std::move(world);return 1;
}
// Original default aggregate mode excludes odd limb segments and fits child-shape world AABBs.
extern "C" int update_ballistics_target(int id,float x,float y,float z){
    if(!ownedWorld)return 0;auto found=ownedBallisticsTargets.find(id);if(found==ownedBallisticsTargets.end())return 0;
    for(float value:{x,y,z})if(!std::isfinite(value))return 0;
    auto& target=*found->second;target.position=btVector3(double(x-float(worldHeader[4])),double(y),double(z-float(worldHeader[5])));
    btVector3 minimum(1e30,1e30,1e30),maximum(-1e30,-1e30,-1e30);
    for(int part=0;part<11;part+=2){
        const auto& body=*target.skeleton->bodies[part];auto* compound=static_cast<const btCompoundShape*>(body.getCollisionShape());
        for(int child=compound->getNumChildShapes()-1;child>=0;child--){
            btVector3 lo,hi;compound->getChildShape(child)->getAabb(body.getWorldTransform()*compound->getChildTransform(child),lo,hi);minimum.setMin(lo);maximum.setMax(hi);
        }
    }
    target.shape->setNativeHalfSizes((maximum-minimum)*double(float(.45)));
    target.object->setWorldTransform(btTransform(btQuaternion(0,0,0,1),(minimum+maximum)*.5));return 1;
}
extern "C" int ballistics_target_pose_state(int id,double* output){
    auto found=ownedBallisticsTargets.find(id);if(found==ownedBallisticsTargets.end()||!output)return 0;const auto& target=*found->second;
    int cursor=0;for(const auto& transform:{target.axis,target.object->getWorldTransform()}){
        for(int row=0;row<3;row++)for(int col=0;col<3;col++)output[cursor++]=transform.getBasis()[row][col];
        for(int axis=0;axis<3;axis++)output[cursor++]=transform.getOrigin()[axis];
    }
    auto half=target.shape->getHalfExtentsWithoutMargin();for(int axis=0;axis<3;axis++)output[cursor++]=half[axis];return 1;
}

// Original controller allocation is separate from target ownership; a nonpositive range gates position updates.
extern "C" int update_ballistics_controller(int id,float x,float y,float z){
    if(!ownedWorld||id<0)return 0;for(float value:{x,y,z})if(!std::isfinite(value))return 0;
    auto found=ownedBallisticsControllers.find(id);
    if(found==ownedBallisticsControllers.end()){
        std::unique_ptr<OwnedBallisticsController> controller;
        if(pooledBallisticsControllers.empty())controller=std::make_unique<OwnedBallisticsController>();
        else{controller=std::move(pooledBallisticsControllers.front());pooledBallisticsControllers.erase(pooledBallisticsControllers.begin());}
        found=ownedBallisticsControllers.emplace(id,std::move(controller)).first;
    }
    if(found->second->range>0)found->second->transform.setOrigin(btVector3(double(x-float(worldHeader[4])),double(y),double(z-float(worldHeader[5]))));return 1;
}
extern "C" int set_ballistics_range(int id,float value){
    if(!ownedWorld||!std::isfinite(value))return 0;auto found=ownedBallisticsControllers.find(id);if(found!=ownedBallisticsControllers.end())found->second->range=value;return 1;
}
extern "C" int set_ballistics_color(int id,float r,float g,float b){
    if(!ownedWorld)return 0;for(float value:{r,g,b})if(!std::isfinite(value))return 0;
    auto found=ownedBallisticsControllers.find(id);if(found!=ownedBallisticsControllers.end())found->second->color=btVector3(r,g,b);return 1;
}
// Original 0x180022ef0 uses angle-axis from fixed forward(0,0,1), including its antiparallel branch.
extern "C" int update_ballistics_direction(int id,float x,float y,float z){
    if(!ownedWorld)return 0;for(float value:{x,y,z})if(!std::isfinite(value))return 0;
    auto found=ownedBallisticsControllers.find(id);if(found==ownedBallisticsControllers.end())return 1;
    btVector3 direction(x,y,z),forward(0,0,1);btQuaternion rotation;
    if((direction+forward).length()<.00001)rotation=btQuaternion(0,std::sin(1.5707963267948966),0,std::cos(1.5707963267948966));
    else{
        btVector3 axis=forward.cross(direction);double angle=std::acos(forward.dot(direction))*.5;
        double multiplier=std::sin(angle)/std::sqrt(axis.length2());
        rotation=btQuaternion(axis.x()*multiplier,axis.y()*multiplier,axis.z()*multiplier,std::cos(angle));
    }
    found->second->transform.setRotation(rotation);return 1;
}
extern "C" int remove_ballistics_controller(int id){
    if(!ownedWorld)return 0;auto found=ownedBallisticsControllers.find(id);if(found==ownedBallisticsControllers.end())return 1;
    pooledBallisticsControllers.push_back(std::move(found->second));ownedBallisticsControllers.erase(found);return 1;
}
static int trace_ballistics_target(const btVector3& from,const btVector3& to,const btVector3& color,float* output){
    btCollisionWorld::ClosestRayResultCallback hit(from,to);ownedWorld->world.rayTest(from,to,hit);
    if(!hit.hasHit())return 0;
    int targetId=-1;OwnedBallisticsTarget* target=nullptr;
    for(const auto& entry:ownedBallisticsTargets)if(entry.second->object.get()==hit.m_collisionObject){targetId=entry.first;target=entry.second.get();break;}
    if(!target){for(const auto& entry:ownedVehicles)if(entry.second->body.get()==hit.m_collisionObject){targetId=entry.first;break;}}
    if(targetId<0)return 0; // Actual closest terrain/non-target collision blocks a target behind it.
    btVector3 point=from+(to-from)*hit.m_closestHitFraction;
    point[0]+=worldHeader[4];point[2]+=worldHeader[5];
    output[0]=float(targetId);for(int axis=0;axis<3;axis++)output[1+axis]=float(point[axis]);
    if(target){target->aggregateHit=true;target->hitPoint=point;target->hitColor=color;}return 1;
}
extern "C" int get_ballistics_targets(int id,float distance,int capacity,float* output){
    if(!ownedWorld||!std::isfinite(distance)||capacity<1||!output)return -1;
    auto found=ownedBallisticsControllers.find(id);if(found==ownedBallisticsControllers.end())return 0;
    const auto& controller=*found->second;const btVector3 from=controller.transform.getOrigin(),to=controller.transform*btVector3(0,0,distance);
    return trace_ballistics_target(from,to,controller.color,output);
}
// Original statically linked CRT rand: per-Java/native-thread state, default seed1, exact unsigned wrap.
static uint32_t original_ballistics_rand(uint32_t& state){state=state*214013u+2531011u;return (state>>16)&32767u;}
extern "C" int get_ballistics_spread(int id,float distance,float spread,float exponent,int count,int capacity,float* output,uint32_t* random){
    if(!ownedWorld||!output||!random||count<0||capacity<count)return -1;
    for(float value:{distance,spread,exponent})if(!std::isfinite(value))return -1;
    auto found=ownedBallisticsControllers.find(id);if(found==ownedBallisticsControllers.end())return 0;
    const auto& controller=*found->second;const auto from=controller.transform.getOrigin();uint32_t state=*random;
    for(int shot=0;shot<count;shot++){
        double angle=double(float(original_ballistics_rand(state)))*6.283185307179586/32767.;
        float unit=float(original_ballistics_rand(state))/32767.f;
        float radial=std::pow(unit,exponent)*spread;
        btVector3 local(std::cos(angle)*double(radial),std::sin(angle)*double(radial),double(distance));
        btVector3 to=controller.transform*local;float* record=output+shot*4;
        record[0]=0;record[1]=float(to.x()+worldHeader[4]);record[2]=float(to.y());record[3]=float(to.z()+worldHeader[5]);
        trace_ballistics_target(from,to,btVector3(0,1,0),record);
    }
    *random=state;return count;
}
extern "C" int ballistics_query_state(int id,double* output){
    if(!output)return 0;auto found=ownedBallisticsControllers.find(id);if(found==ownedBallisticsControllers.end())return 0;
    const auto& controller=*found->second;int cursor=0;for(int row=0;row<3;row++)for(int col=0;col<3;col++)output[cursor++]=controller.transform.getBasis()[row][col];
    for(int axis=0;axis<3;axis++)output[cursor++]=controller.transform.getOrigin()[axis];output[12]=controller.range;return 1;
}
extern "C" int ballistics_target_hit_state(int id,double* output){
    auto found=ownedBallisticsTargets.find(id);if(found==ownedBallisticsTargets.end()||!output)return 0;const auto& target=*found->second;
    output[0]=target.aggregateHit?1:0;for(int axis=0;axis<3;axis++){output[1+axis]=target.hitPoint[axis];output[4+axis]=target.hitColor[axis];}return 1;
}

extern "C" int set_ballistics_size(int id,float size){
    if(!ownedWorld||!std::isfinite(size))return 0;auto found=ownedBallisticsControllers.find(id);if(found==ownedBallisticsControllers.end())return 1;
    const btVector3 scale(size,size,size);found->second->aperture->setLocalScaling(scale);found->second->sphere->setLocalScaling(scale);return 1;
}
extern "C" int update_ballistics_reticle_position(int id,float x,float y,float z){
    if(!ownedWorld)return 0;for(float value:{x,y,z})if(!std::isfinite(value))return 0;
    auto found=ownedBallisticsControllers.find(id);if(found!=ownedBallisticsControllers.end())found->second->reticle.setOrigin(btVector3(double(x-float(worldHeader[4])),double(y),double(z-float(worldHeader[5]))));return 1;
}
// Original quaternion setter changes the shared reticle basis; rotate and axis-angle setters do not.
extern "C" int update_ballistics_reticle_rotation(int id,float x,float y,float z,float w,int mode){
    if(!ownedWorld||mode<0||mode>2)return 0;for(float value:{x,y,z,w})if(!std::isfinite(value))return 0;
    auto found=ownedBallisticsControllers.find(id);if(found==ownedBallisticsControllers.end())return 1;
    btQuaternion rotation;
    if(mode==2){btVector3 axis(x,y,z);if(axis.length2()==0)return 0;rotation=btQuaternion(axis,double(w));}
    else{rotation=btQuaternion(x,y,z,w);if(rotation.length2()==0)return 0;}
    auto& reticle=found->second->reticle;if(mode==1)rotation=reticle.getRotation()*rotation;reticle.setRotation(rotation);
    if(mode==0)globalBallisticsReticle.setBasis(reticle.getBasis());return 1;
}
extern "C" int ballistics_reticle_state(int id,double* output){
    auto found=ownedBallisticsControllers.find(id);if(found==ownedBallisticsControllers.end()||!output)return 0;const auto& controller=*found->second;int cursor=0;
    for(int row=0;row<3;row++)for(int col=0;col<3;col++)output[cursor++]=controller.reticle.getBasis()[row][col];
    for(int axis=0;axis<3;axis++)output[cursor++]=controller.reticle.getOrigin()[axis];
    for(const auto& scale:{controller.aperture->getLocalScaling(),controller.sphere->getLocalScaling()})for(int axis=0;axis<3;axis++)output[cursor++]=scale[axis];
    for(const btCollisionShape* shape:{static_cast<const btCollisionShape*>(controller.aperture.get()),static_cast<const btCollisionShape*>(controller.sphere.get())}){
        btVector3 lo,hi;shape->getAabb(btTransform::getIdentity(),lo,hi);for(const auto& point:{lo,hi})for(int axis=0;axis<3;axis++)output[cursor++]=point[axis];
    }
    for(int row=0;row<3;row++)for(int col=0;col<3;col++)output[cursor++]=globalBallisticsReticle.getBasis()[row][col];return 1;
}

static int ballistics_part_priority(int part){return part==2?0:part==1?1:part==0?2:3;}
extern "C" int get_targeted_body_part(int id){
    auto found=ownedBallisticsTargets.find(id);if(found==ownedBallisticsTargets.end())return 11;
    for(int part=0;part<11;part++)if(found->second->bodyHit[part])return part;return 11;
}
extern "C" int get_ballistics_camera_targets(int id,float range,int capacity,int detailed,float* output){
    if(!ownedWorld||!output||!std::isfinite(range)||capacity<1)return -1;
    auto found=ownedBallisticsControllers.find(id);if(found==ownedBallisticsControllers.end())return 0;
    const auto& controller=*found->second;btVector3 backward=-controller.reticle.getBasis().getColumn(2);
    if(backward.length2()==0)return 0;backward.normalize();
    const btVector3 from=controller.reticle.getOrigin()-backward*150.,to=controller.reticle.getOrigin()+backward*150.;
    btCollisionWorld::AllHitsRayResultCallback hit(from,to);ownedWorld->world.rayTest(from,to,hit);
    int count=0;std::vector<OwnedBallisticsTarget*> candidates;
    for(int index=0;index<hit.m_collisionObjects.size()&&count<capacity;index++){
        OwnedBallisticsTarget* target=nullptr;int targetId=-1;
        for(const auto& entry:ownedBallisticsTargets)if(entry.second->object.get()==hit.m_collisionObjects[index]){target=entry.second.get();targetId=entry.first;break;}
        if(!target||(controller.transform.getOrigin()-target->object->getWorldTransform().getOrigin()).length()>double(range))continue;
        target->aggregateHit=true;target->hitColor=controller.color;float* row=output+count*5;row[0]=float(targetId);
        // Original0x1800202cc reads the first AllHits point for every accepted aggregate.
        for(int axis=0;axis<3;axis++)row[1+axis]=float(hit.m_hitPointWorld[0][axis]+(axis==0?worldHeader[4]:axis==2?worldHeader[5]:0));
        row[4]=11;candidates.push_back(target);count++;
    }
    if(!detailed||count==0)return count;
    for(auto* target:candidates)for(const auto& body:target->skeleton->bodies)if(body->getBroadphaseHandle())return -1;
    for(auto* target:candidates)for(const auto& body:target->skeleton->bodies){body->setCollisionFlags(4);ownedWorld->world.addCollisionObject(body.get(),16,-1);}
    ownedWorld->world.rayTest(from,to,hit);int selected=-1;
    for(int index=0;index<hit.m_collisionObjects.size();index++)for(int candidate=0;candidate<count;candidate++){
        auto* target=candidates[candidate];for(int part=0;part<11;part++)if(target->skeleton->bodies[part].get()==hit.m_collisionObjects[index]){
            if(selected<0||ballistics_part_priority(part)<ballistics_part_priority(selected)){output[candidate*5+4]=float(part);selected=part;}
            target->bodyHit[part]=true;target->bodyHitColor[part]=controller.color;
        }
    }
    for(auto* target:candidates)for(const auto& body:target->skeleton->bodies)ownedWorld->world.removeCollisionObject(body.get());return count;
}
