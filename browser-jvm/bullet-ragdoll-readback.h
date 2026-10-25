// Original skeleton reconstruction and output normalization (0x18001a120 and 0x18001dff0).
extern "C" int ragdoll_bone_count(int id){auto* owner=findRagdoll(id);return owner?int(owner->definition->parents.size()):-1;}
static void writeRagdollTransform(const btTransform& transform,float* output){
    const auto& origin=transform.getOrigin();btQuaternion rotation;transform.getBasis().getRotation(rotation);
    for(int axis=0;axis<3;axis++)output[axis]=float(origin[axis]);for(int axis=0;axis<4;axis++)output[3+axis]=float(rotation[axis]);
}
extern "C" int read_ragdoll(int id,float* output,int capacity,float* rigidOutput){
    if(!ownedWorld)return -1;auto* owner=findRagdoll(id);if(!owner)return -1;
    int count=int(owner->definition->parents.size());
    if(!owner->anchorsReady||count<35||!output||capacity<count*7||owner->poseLocal.size()!=count||owner->boneOffsets.size()!=count||owner->boneParts.size()!=count)return -1;
    auto local=owner->poseLocal;std::vector<btTransform> world(count);
    const btTransform inverseRoot=owner->root.inverse();
    for(int bone=0;bone<count;bone++){
        int parent=owner->definition->parents[bone],part=owner->boneParts[bone];world[bone]=bone==0?local[bone]:world[parent]*local[bone];
        if(part>=0){world[bone]=inverseRoot*owner->bodies[part]->getWorldTransform()*owner->boneOffsets[bone].inverse();local[bone]=bone==0?world[bone]:world[parent].inverseTimes(world[bone]);}
    }
    // Original output removes root translation, makes Bip01 world-identity, and copies pelvis world to bone34.
    local[0]=owner->rawRootPose;local[0].setOrigin(btVector3(0,0,0));world[0]=local[0];
    for(int bone=1;bone<count;bone++){
        int parent=owner->definition->parents[bone];
        if(bone==1)local[bone]=world[parent].inverse();
        else if(bone==34)local[bone]=world[parent].inverseTimes(world[2]);
        world[bone]=world[parent]*local[bone];
    }
    for(int bone=0;bone<count;bone++)writeRagdollTransform(local[bone],output+bone*7);
    if(rigidOutput)for(int part=0;part<11;part++)writeRagdollTransform(owner->bodies[part]->getWorldTransform(),rigidOutput+part*7);
    if(rigidOutput)for(auto& body:owner->bodies){const auto velocity=body->getLinearVelocity();double speed=velocity.length();if(speed>10)body->setLinearVelocity(velocity*(10/speed));}
    // Simulation retains the postrotated root basis while output normalization removes root/Bip01 translation.
    owner->poseLocal=std::move(local);owner->poseLocal[0].setBasis((owner->rawRootPose*owner->localRotation).getBasis());
    owner->poseWorld[0]=owner->poseLocal[0];for(int bone=1;bone<count;bone++)owner->poseWorld[bone]=owner->poseWorld[owner->definition->parents[bone]]*owner->poseLocal[bone];
    return count;
}
