#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "ForgeInteractable.h"
#include "ForgeInteractableDoor.generated.h"

class UStaticMeshComponent;
class UForgeDoorSaveGame;

UENUM(BlueprintType)
enum class EForgeDoorState : uint8
{
	Closed = 0,
	Opening = 1,
	Open = 2,
	Closing = 3
};

/**
 * Reusable native door actor. The Blender leaf mesh's own pivot is centered
 * (verified via asset bounds), NOT at the hinge edge — so the actor inserts a
 * HingePivot scene component at the hinge line (door-local x=-48) and parents
 * the leaf at +48 under it. Rotating HingePivot yields a true hinged swing;
 * opening is a relative-yaw rotation driven natively in Tick — no scripts, no
 * timelines required from outside.
 *
 * Interaction policy: Interact always accepted. From a stable state it starts
 * the opposite transition; from a transitional state it reverses direction.
 * Persistence policy: only stable states (Closed/Open) are saved, written when
 * a transition settles. On restore, any non-stable record normalizes to the
 * nearest stable state (documented and asserted by the driver).
 */
UCLASS(BlueprintType, Blueprintable)
class FORGEGAMEPLAY_API AForgeInteractableDoor : public AActor, public IForgeInteractable
{
	GENERATED_BODY()
public:
	AForgeInteractableDoor();

	virtual void BeginPlay() override;
	virtual void Tick(float DeltaSeconds) override;

	virtual bool ForgeCanInteract(AActor* Interactor) const override;
	virtual void ForgeInteract(AActor* Interactor) override;
	virtual FName ForgeGetInteractState() const override;

	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "ForgeDoor")
	USceneComponent* DoorRoot = nullptr;

	/** Rotation pivot at the door-local hinge line (x=-48). All open/close
	 *  rotation is applied here so the leaf swings about the hinge edge. */
	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "ForgeDoor")
	USceneComponent* HingePivot = nullptr;

	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "ForgeDoor")
	UStaticMeshComponent* FrameMesh = nullptr;

	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "ForgeDoor")
	UStaticMeshComponent* LeafMesh = nullptr;

	/** Stable per-instance identity used as the save record key. Auto-filled
	 *  from the placed actor's name on BeginPlay when left empty — stable
	 *  because placed actor names are serialized into the level. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "ForgeDoor")
	FName DoorInstanceId;

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "ForgeDoor")
	float OpenAngleDeg = -95.f;

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "ForgeDoor")
	float TransitionS = 0.8f;

	/** When true the door writes its record to the save slot on every settle. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "ForgeDoor")
	bool bAutoPersist = true;

	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "ForgeDoor")
	EForgeDoorState DoorState = EForgeDoorState::Closed;

	/** Last commanded leaf yaw — retained so callers can compare commanded vs
	 *  observed component rotation (R80's anti-silent-failure discipline). */
	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "ForgeDoor")
	float LeafYawDeg = 0.f;

	/** Restores state from the save slot if a record exists for DoorInstanceId.
	 *  Returns false on absent/corrupt/unsupported save — never throws. */
	bool ApplyRestoredState();

	/** Writes this door's record into the slot. Only stable states persist. */
	bool PersistDoorState();

	float TargetYawForState(EForgeDoorState State) const;

	static FName StableStateName(EForgeDoorState State);

	/** Dedicated pilot slot — never shares with real game saves. */
	static const FString& GetSaveSlotName();
};
