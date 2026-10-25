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
extern "C" int clear_ballistics_targets(){
    if(!ownedWorld)return ownedBallisticsTargets.empty()?1:0;
    while(!ownedBallisticsTargets.empty())if(remove_ballistics_target(ownedBallisticsTargets.begin()->first)<0)return 0;
    pooledBallisticsTargets.clear();return 1;
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
