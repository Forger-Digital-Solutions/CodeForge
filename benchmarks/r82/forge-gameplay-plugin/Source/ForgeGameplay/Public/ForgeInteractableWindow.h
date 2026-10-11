#pragma once
#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "ForgeInteractable.h"
#include "ForgeInteractableWindow.generated.h"

class UStaticMeshComponent;

UENUM(BlueprintType)
enum class EForgeWindowState : uint8 { Closed = 0, Opening = 1, Open = 2, Closing = 3 };

UCLASS(BlueprintType, Blueprintable)
class FORGEGAMEPLAY_API AForgeInteractableWindow : public AActor, public IForgeInteractable
{
    GENERATED_BODY()
public:
    AForgeInteractableWindow();
    virtual void BeginPlay() override;
    virtual void Tick(float DeltaSeconds) override;
    virtual bool ForgeCanInteract(AActor* Interactor) const override;
    virtual void ForgeInteract(AActor* Interactor) override;
    virtual FName ForgeGetInteractState() const override;
    bool PersistWindowState();
    bool ApplyRestoredState();

    UPROPERTY(VisibleAnywhere, BlueprintReadOnly) USceneComponent* WindowRoot;
    UPROPERTY(VisibleAnywhere, BlueprintReadOnly) USceneComponent* SlidePivot;
    UPROPERTY(VisibleAnywhere, BlueprintReadOnly) UStaticMeshComponent* FrameMesh;
    UPROPERTY(VisibleAnywhere, BlueprintReadOnly) UStaticMeshComponent* SashMesh;
    UPROPERTY(EditAnywhere, BlueprintReadWrite) FName WindowInstanceId;
    UPROPERTY(EditAnywhere, BlueprintReadWrite) float OpenTravelCm = 65.f;
    UPROPERTY(EditAnywhere, BlueprintReadWrite) float TransitionS = 0.8f;
    UPROPERTY(EditAnywhere, BlueprintReadWrite) bool bAutoPersist = true;
    UPROPERTY(VisibleAnywhere, BlueprintReadOnly) EForgeWindowState WindowState = EForgeWindowState::Closed;
    UPROPERTY(VisibleAnywhere, BlueprintReadOnly) float SlideCm = 0.f;
    UPROPERTY(VisibleAnywhere, BlueprintReadOnly) bool bRestored = false;
};
