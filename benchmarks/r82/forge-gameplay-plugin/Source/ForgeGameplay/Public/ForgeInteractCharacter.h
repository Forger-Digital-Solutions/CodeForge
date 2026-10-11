#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Character.h"
#include "ForgeInteractCharacter.generated.h"

/**
 * Native possessed pawn for ForgeAAA gameplay tests. Binds the configured
 * "ForgeInteract" action through the real input pipeline; targeting is a
 * forward sphere sweep validated against IForgeInteractable — range and
 * eligibility are enforced before any state change.
 */
UCLASS()
class FORGEGAMEPLAY_API AForgeInteractCharacter : public ACharacter
{
	GENERATED_BODY()
public:
	AForgeInteractCharacter();

	virtual void SetupPlayerInputComponent(UInputComponent* PlayerInputComponent) override;

	/** Max reach of the interact sweep, cm. Out-of-range presses are misses. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "ForgeInteract")
	float InteractRangeCm = 90.f;

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "ForgeInteract")
	float InteractProbeRadiusCm = 40.f;

	/** Evidence for the test driver: what the last press actually did. */
	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "ForgeInteract")
	bool bLastInteractDispatched = false;

	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "ForgeInteract")
	FName LastInteractTargetName;

	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "ForgeInteract")
	float LastInteractDistanceCm = 0.f;

	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "ForgeInteract")
	FName LastInteractResultState;

	/** Debug evidence: every sweep hit of the last press (actor/component/dist). */
	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "ForgeInteract")
	TArray<FString> LastSweepHits;

	/** Facing actually used for the last sweep — catches controller-vs-actor yaw bugs. */
	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "ForgeInteract")
	float LastSweepYawDeg = 0.f;

private:
	void OnInteractPressed();
	void MoveForwardAxis(float Value);
	void MoveRightAxis(float Value);
};
