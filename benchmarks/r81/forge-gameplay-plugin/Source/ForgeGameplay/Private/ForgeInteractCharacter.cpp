#include "ForgeInteractCharacter.h"

#include "Engine/World.h"
#include "ForgeInteractable.h"
#include "GameFramework/Controller.h"

AForgeInteractCharacter::AForgeInteractCharacter()
{
	PrimaryActorTick.bCanEverTick = true;
}

void AForgeInteractCharacter::SetupPlayerInputComponent(UInputComponent* PlayerInputComponent)
{
	Super::SetupPlayerInputComponent(PlayerInputComponent);
	PlayerInputComponent->BindAction("ForgeInteract", IE_Pressed, this, &AForgeInteractCharacter::OnInteractPressed);
	PlayerInputComponent->BindAxis("MoveForward", this, &AForgeInteractCharacter::MoveForwardAxis);
	PlayerInputComponent->BindAxis("MoveRight", this, &AForgeInteractCharacter::MoveRightAxis);
}

void AForgeInteractCharacter::OnInteractPressed()
{
	bLastInteractDispatched = false;
	LastInteractTargetName = NAME_None;
	LastInteractDistanceCm = 0.f;
	LastInteractResultState = NAME_None;
	LastSweepHits.Reset();

	// The sweep follows the controller's aim — that is where a real player is
	// looking when they press the key. Actor yaw is not authoritative (it can
	// lag or be re-synced by the movement component).
	FRotator AimRot = GetActorRotation();
	if (const AController* C = GetController())
	{
		AimRot = C->GetControlRotation();
	}
	const FVector Start = GetActorLocation();
	const FVector End = Start + AimRot.Vector() * InteractRangeCm;
	LastSweepYawDeg = AimRot.Yaw;
	TArray<FHitResult> Hits;
	FCollisionQueryParams Params;
	Params.AddIgnoredActor(this);
	const bool bHit = GetWorld()->SweepMultiByChannel(
		Hits, Start, End, FQuat::Identity, ECC_Visibility,
		FCollisionShape::MakeSphere(InteractProbeRadiusCm), Params);
	for (const FHitResult& H : Hits)
	{
		LastSweepHits.Add(FString::Printf(TEXT("%s/%s@%.1f%s"),
			H.GetActor() ? *H.GetActor()->GetName() : TEXT("?"),
			H.GetComponent() ? *H.GetComponent()->GetName() : TEXT("?"),
			H.Distance, H.bStartPenetrating ? TEXT("*") : TEXT("")));
	}
	if (!bHit)
	{
		return;
	}
	Hits.Sort([](const FHitResult& A, const FHitResult& B) { return A.Distance < B.Distance; });
	for (const FHitResult& Hit : Hits)
	{
		AActor* Candidate = Hit.GetActor();
		if (Candidate == nullptr || !Candidate->Implements<UForgeInteractable>())
		{
			continue;
		}
		IForgeInteractable* Interactable = Cast<IForgeInteractable>(Candidate);
		if (Interactable == nullptr || !Interactable->ForgeCanInteract(this))
		{
			continue;
		}
		bLastInteractDispatched = true;
		LastInteractTargetName = Candidate->GetFName();
		LastInteractDistanceCm = Hit.Distance;
		Interactable->ForgeInteract(this);
		LastInteractResultState = Interactable->ForgeGetInteractState();
		return;
	}
}

void AForgeInteractCharacter::MoveForwardAxis(float Value)
{
	AddMovementInput(GetActorForwardVector(), Value);
}

void AForgeInteractCharacter::MoveRightAxis(float Value)
{
	AddMovementInput(GetActorRightVector(), Value);
}
